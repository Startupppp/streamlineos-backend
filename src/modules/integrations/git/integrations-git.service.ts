import { Inject, Injectable } from "@nestjs/common";
import { asc, and, eq, inArray, isNull, sql } from "drizzle-orm";
import { gitConnections, gitTicketLinks, projectStatuses, projects, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { logger } from "../../../common/logger/logger.service";
import { verifyGithubSignature, verifyGitlabToken } from "./git-signature";
import { asRecord, extractTicketRefs, parseEvent } from "./git-event-parser";
import { ProjectsTicketsService } from "../../build/core/projects-tickets.service";
import type {
  GitLinkInput,
  GitProvider,
  ParsedTicketRef,
  ResolvedTicket,
  WebhookRequest,
} from "./git.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const SYSTEM_ACTOR: Omit<CurrentUserContext, "orgId"> = {
  userId: "system",
  role: "SYSTEM",
  permissions: [],
  isOrgOwner: true,
  tokenScopes: null,
  sessionId: "git-webhook",
};

@Injectable()
export class IntegrationsGitService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly projectsTickets: ProjectsTicketsService,
  ) {}

  async processWebhook(req: WebhookRequest): Promise<void> {
    const connectionId = Number(req.connectionIdRaw ?? null);
    if (!Number.isFinite(connectionId)) return;

    const orgIdRows = await this.db.execute(
      sql`SELECT app.resolve_git_connection_org_id(${connectionId}) AS org_id`,
    );
    const orgId = orgIdRows[0]?.org_id ? String(orgIdRows[0].org_id) : null;
    if (!orgId) return;

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const connection = await tx.query.gitConnections.findFirst({
          where: eq(gitConnections.id, connectionId),
        });
        if (!connection || !connection.isActive) return;

        const provider = connection.provider;
        if (!this.verifySignature(provider, connection.webhookSecret, req)) {
          logger.warn("[git-webhook] signature verification failed", { connectionId });
          return;
        }

        let body: Record<string, unknown> | null;
        try {
          const parsed: unknown = JSON.parse(req.rawBody);
          body = asRecord(parsed);
        } catch {
          return;
        }
        if (!body) return;

        const eventType = provider === "gitlab" ? req.gitlabEvent ?? null : req.githubEvent ?? null;
        const parsedRefs = parseEvent(provider, eventType, body);
        if (parsedRefs.length === 0) return;

        const links: GitLinkInput[] = [];
        for (const parsed of parsedRefs) {
          const ticketRefs = extractTicketRefs(parsed.text);
          if (ticketRefs.length === 0) continue;
          const resolved = await this.resolveTicketsByRef(connection.orgId, ticketRefs);
          for (const { ticketId } of resolved) {
            links.push({
              orgId: connection.orgId,
              ticketId,
              connectionId: connection.id,
              provider,
              refType: parsed.refType,
              externalId: parsed.externalId,
              title: parsed.title,
              url: parsed.url,
              author: parsed.author,
              status: parsed.status,
            });
          }
        }

        if (links.length > 0) {
          await this.recordLinks(links);
        }

        const mergedPrLinks = links.filter((l) => l.refType === "pull_request" && l.status === "merged");
        if (mergedPrLinks.length > 0) {
          void this.autoTransitionOnMerge(connection.orgId, mergedPrLinks).catch((error) =>
            logger.error("[git-webhook] auto-transition failed", { error }),
          );
        }
      },
      { orgId },
    );
  }

  private async autoTransitionOnMerge(orgId: string, mergedLinks: GitLinkInput[]): Promise<void> {
    const ticketIds = Array.from(new Set(mergedLinks.map((l) => l.ticketId)));
    if (ticketIds.length === 0) return;

    const ticketRows = await this.db
      .select({ id: tickets.id, projectId: tickets.projectId, status: tickets.status })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt), inArray(tickets.id, ticketIds)));

    const projectIds = Array.from(new Set(ticketRows.map((t) => t.projectId).filter((p): p is number => p !== null)));
    if (projectIds.length === 0) return;

    const completedStatuses = await this.db
      .select({ projectId: projectStatuses.projectId, name: projectStatuses.name })
      .from(projectStatuses)
      .where(
        and(
          eq(projectStatuses.orgId, orgId),
          inArray(projectStatuses.projectId, projectIds),
          eq(projectStatuses.type, "completed"),
        ),
      )
      .orderBy(asc(projectStatuses.order));

    const projectCompletedStatus = new Map<number, string>();
    for (const row of completedStatuses) {
      if (!projectCompletedStatus.has(row.projectId)) {
        projectCompletedStatus.set(row.projectId, row.name);
      }
    }

    for (const ticket of ticketRows) {
      if (!ticket.projectId) continue;
      const targetStatus = projectCompletedStatus.get(ticket.projectId);
      if (!targetStatus || ticket.status === targetStatus) continue;
      const systemCtx: CurrentUserContext = { ...SYSTEM_ACTOR, orgId };
      try {
        await this.projectsTickets.updateTicket(systemCtx, ticket.id, { status: targetStatus });
      } catch (error) {
        logger.warn("[git-webhook] skipped auto-transition", { ticketId: ticket.id, error });
      }
    }
  }

  private verifySignature(provider: GitProvider, secret: string, req: WebhookRequest): boolean {
    if (provider === "gitlab") {
      return verifyGitlabToken(secret, req.gitlabToken);
    }
    return verifyGithubSignature(secret, req.rawBody, req.signature256);
  }

  private async resolveTicketsByRef(
    orgId: string,
    refs: ParsedTicketRef[],
  ): Promise<ResolvedTicket[]> {
    if (refs.length === 0) return [];

    const keyedRefs = refs.filter(
      (r): r is ParsedTicketRef & { projectKey: string } => r.projectKey !== null,
    );
    const bareRefs = refs.filter((r) => r.projectKey === null);
    const resolved: ResolvedTicket[] = [];

    if (keyedRefs.length > 0) {
      const projectKeys = Array.from(new Set(keyedRefs.map((r) => r.projectKey)));
      const projectRows = await this.db
        .select({ id: projects.id, key: projects.key })
        .from(projects)
        .where(and(eq(projects.orgId, orgId), inArray(projects.key, projectKeys)));

      const keyToProjectId = new Map(projectRows.map((p) => [p.key, p.id]));
      const projectIds = projectRows.map((p) => p.id);

      if (projectIds.length > 0) {
        const ticketRows = await this.db
          .select({ id: tickets.id, projectId: tickets.projectId, ticketNumber: tickets.ticketNumber })
          .from(tickets)
          .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt), inArray(tickets.projectId, projectIds)));

        const ticketLookup = new Map<string, number>();
        for (const t of ticketRows) {
          if (t.projectId === null) continue;
          ticketLookup.set(`${t.projectId}#${t.ticketNumber}`, t.id);
        }

        for (const ref of keyedRefs) {
          const projectId = keyToProjectId.get(ref.projectKey);
          if (projectId === undefined) continue;
          const ticketId = ticketLookup.get(`${projectId}#${ref.ticketNumber}`);
          if (ticketId === undefined) continue;
          resolved.push({ ref, ticketId });
        }
      }
    }

    if (bareRefs.length > 0) {
      const numbers = Array.from(new Set(bareRefs.map((r) => r.ticketNumber)));
      const ticketRows = await this.db
        .select({ id: tickets.id, ticketNumber: tickets.ticketNumber })
        .from(tickets)
        .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt), inArray(tickets.ticketNumber, numbers)));

      const numberToTicketIds = new Map<number, number[]>();
      for (const t of ticketRows) {
        const existing = numberToTicketIds.get(t.ticketNumber) ?? [];
        existing.push(t.id);
        numberToTicketIds.set(t.ticketNumber, existing);
      }

      for (const ref of bareRefs) {
        const candidates = numberToTicketIds.get(ref.ticketNumber) ?? [];
        if (candidates.length !== 1) continue;
        resolved.push({ ref, ticketId: candidates[0] });
      }
    }

    return resolved;
  }

  private async recordLinks(links: GitLinkInput[]): Promise<number> {
    if (links.length === 0) return 0;

    const values = links.map((link) => ({
      orgId: link.orgId,
      ticketId: link.ticketId,
      connectionId: link.connectionId,
      provider: link.provider,
      refType: link.refType,
      externalId: link.externalId,
      title: link.title ?? null,
      url: link.url ?? null,
      author: link.author ?? null,
      status: link.status ?? null,
    }));

    try {
      const inserted = await this.db
        .insert(gitTicketLinks)
        .values(values)
        .onConflictDoNothing({
          target: [gitTicketLinks.ticketId, gitTicketLinks.refType, gitTicketLinks.externalId],
        })
        .returning({ id: gitTicketLinks.id });
      return inserted.length;
    } catch (error) {
      logger.error("[git-integration] failed to record links", { error });
      return 0;
    }
  }
}
