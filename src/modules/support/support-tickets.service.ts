import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { SupportTicketStaleException } from "../../common/http/api-exceptions";
import { and, asc, count, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import {
  supportTickets,
  supportTicketMessages,
  supportTicketActivity,
  supportTicketLinks,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import { SupportMacrosService } from "./support-macros.service";
import { SupportNotificationsService } from "./support-notifications.service";
import { SupportRealtimeService } from "./support-realtime.service";
import { SupportSlaService } from "./support-sla.service";
import { SupportCsatService } from "./support-csat.service";
import { SupportAiService } from "./support-ai.service";
import { AutomationService } from "../automation/automation.service";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import type {
  CreateTicketInput,
  CreateTicketLinkInput,
  ListTicketsInput,
  MergeTicketInput,
  ReplyMessageInput,
  TicketPriority,
  TicketStatus,
  UpdateTicketInput,
} from "./dto/support.schemas";

type ListTicketsQuery = ListTicketsInput & { scope?: DataScope; userId?: string };

const TICKET_PRIORITIES: readonly TicketPriority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];

const ACTION_LABELS: Record<string, string> = {
  created: "created the ticket",
  status_changed: "changed status",
  priority_changed: "changed priority",
  assignee_changed: "changed assignee",
  replied: "replied",
  internal_note: "added an internal note",
  resolved: "resolved the ticket",
  reopened: "reopened the ticket",
  merged: "merged the ticket",
  split: "split the ticket",
  linked: "linked a related ticket",
};

// Mirrors the `support_activity_action` Postgres enum (db/schema/support/support-activity.ts).
// "split" is reserved in ACTION_LABELS for a future phase but isn't in the DB enum yet
// (split itself isn't implemented — see mergeTicket()/addTicketLink() for merged/linked).
type TicketActivityAction =
  | "created"
  | "status_changed"
  | "priority_changed"
  | "assignee_changed"
  | "replied"
  | "internal_note"
  | "resolved"
  | "reopened"
  | "merged"
  | "linked";

function isTicketPriority(value: string): value is TicketPriority {
  return (TICKET_PRIORITIES as readonly string[]).includes(value);
}

@Injectable()
export class SupportTicketsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly macros: SupportMacrosService,
    private readonly notifications: SupportNotificationsService,
    private readonly realtime: SupportRealtimeService,
    private readonly sla: SupportSlaService,
    private readonly automations: AutomationService,
    private readonly csat: SupportCsatService,
    private readonly ai: SupportAiService,
  ) {}

  private buildAutomationPayload(ticket: {
    id: number;
    title: string;
    status: string;
    priority: string;
    category?: string | null;
    assigneeId?: string | null;
  }): Record<string, unknown> {
    return {
      ticketId: ticket.id,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category ?? null,
      assigneeId: ticket.assigneeId ?? null,
    };
  }

  listTickets(orgId: string, query: ListTicketsQuery) {
    const { status, priority, assigneeId, queueId, page, limit, scope, userId } = query;
    const key = `support:tickets:${orgId}:${status ?? ""}:${priority ?? ""}:${assigneeId ?? ""}:${queueId ?? ""}:${scope ?? ""}:${userId ?? ""}:${page}:${limit}`;
    return this.cache.cached(
      key,
      async () => {
        const offset = (page - 1) * limit;
        const conditions: SQL[] = [eq(supportTickets.orgId, orgId)];
        if (status) conditions.push(eq(supportTickets.status, status));
        if (priority) conditions.push(eq(supportTickets.priority, priority));
        if (assigneeId) conditions.push(eq(supportTickets.assigneeId, assigneeId));
        if (queueId) conditions.push(eq(supportTickets.queueId, queueId));
        if (scope && scope !== "none" && userId) {
          conditions.push(applyScope(scope, userId, { ownerColumn: supportTickets.assigneeId }));
        } else if (scope === "none") {
          return { items: [], total: 0, page, totalPages: 0 };
        }

        const [items, [countResult]] = await Promise.all([
          this.db.query.supportTickets.findMany({
            where: and(...conditions),
            orderBy: [desc(supportTickets.createdAt)],
            limit,
            offset,
            with: {
              client: { columns: { id: true, name: true } },
              assignee: { columns: { id: true, name: true, image: true } },
              creator: { columns: { id: true, name: true } },
            },
          }),
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(supportTickets)
            .where(and(...conditions)),
        ]);

        const total = countResult?.count ?? 0;
        return { items, total, page, totalPages: Math.ceil(total / limit) };
      },
      CACHE_TTL.SHORT,
    );
  }

  async createTicket(
    orgId: string,
    userId: string,
    input: CreateTicketInput,
    source?: {
      channel: string;
      messageId?: string | null;
      requesterEmail?: string | null;
      requesterName?: string | null;
    },
  ) {
    const possibleDuplicate = await this.db.query.supportTickets.findFirst({
      where: and(
        eq(supportTickets.orgId, orgId),
        sql`LOWER(${supportTickets.title}) = LOWER(${input.title})`,
        sql`${supportTickets.status} IN ('OPEN', 'IN_PROGRESS')`,
      ),
      columns: { id: true, title: true },
    });

    const callerSetPriority = input.priority !== undefined;
    let finalPriority: TicketPriority = input.priority ?? "MEDIUM";
    let finalAssigneeId = input.assigneeId;

    try {
      const routing = await this.macros.applyRoutingRules(orgId, {
        title: input.title,
        category: input.category ?? null,
        description: input.description ?? null,
        priority: finalPriority,
      });
      if (routing.assigneeId && !input.assigneeId) {
        finalAssigneeId = routing.assigneeId;
      }
      if (routing.setPriority && !callerSetPriority && isTicketPriority(routing.setPriority)) {
        finalPriority = routing.setPriority;
      }
    } catch (routingError) {
      logger.error("Support routing rules failed to apply", {
        orgId,
        error: routingError instanceof Error ? routingError.message : String(routingError),
      });
    }

    const resolvedPolicy = await this.sla.resolvePolicy(orgId, finalPriority, input.category ?? null);
    const { firstResponseDueAt, resolutionDueAt } = this.sla.computeDueDates(resolvedPolicy, new Date());

    const [ticket] = await this.db
      .insert(supportTickets)
      .values({
        orgId,
        title: input.title,
        category: input.category ?? null,
        description: input.description ?? null,
        clientId: input.clientId ?? null,
        priority: finalPriority,
        assigneeId: finalAssigneeId ?? null,
        slaDeadline: resolutionDueAt,
        firstResponseDueAt,
        createdBy: userId,
        sourceChannel: source?.channel ?? "web",
        sourceMessageId: source?.messageId ?? null,
        requesterEmail: source?.requesterEmail ?? null,
        requesterName: source?.requesterName ?? null,
      })
      .returning();

    await this.invalidateTicketCaches(orgId);
    await this.recordActivity(orgId, ticket.id, userId, "created", null, input.title);

    void this.automations
      .runAutomationsForEvent(orgId, "ticket.created", this.buildAutomationPayload(ticket))
      .catch(() => undefined);

    void this.ai.runFullAnalysis(orgId, ticket.id).catch(() => undefined);

    if (finalAssigneeId) {
      void this.notifications
        .sendAssignmentEmail(finalAssigneeId, userId, input.title, finalPriority, ticket.id, "User")
        .catch(() => undefined);
    }

    return {
      ...ticket,
      possibleDuplicateOf: possibleDuplicate
        ? { id: possibleDuplicate.id, title: possibleDuplicate.title }
        : null,
    };
  }

  async getTicket(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      with: {
        client: true,
        assignee: { columns: { id: true, name: true, image: true } },
        creator: { columns: { id: true, name: true } },
        messages: {
          with: { author: { columns: { id: true, name: true, image: true } } },
          orderBy: [asc(supportTicketMessages.createdAt)],
        },
      },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    return ticket;
  }

  async updateTicket(orgId: string, ticketId: number, userId: string, input: UpdateTicketInput) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    if (input.expectedUpdatedAt && input.expectedUpdatedAt.getTime() !== ticket.updatedAt.getTime()) {
      throw new SupportTicketStaleException();
    }

    const updateData: Partial<typeof supportTickets.$inferInsert> = { updatedAt: new Date() };
    if (input.status) {
      updateData.status = input.status;
      if (input.status === "RESOLVED") updateData.resolvedAt = new Date();
      if (input.status === "CLOSED") updateData.closedAt = new Date();

      const policy = await this.sla.resolvePolicy(orgId, ticket.priority, ticket.category);
      const pauseTransition = this.sla.computePauseTransition(
        ticket.status,
        input.status,
        policy.pauseStatuses,
        ticket.slaPausedAt,
        ticket.slaPausedMinutes,
      );
      updateData.slaPausedAt = pauseTransition.slaPausedAt;
      updateData.slaPausedMinutes = pauseTransition.slaPausedMinutes;
      if (pauseTransition.extendByMinutes > 0) {
        const extendMs = pauseTransition.extendByMinutes * 60_000;
        if (!ticket.firstRespondedAt && ticket.firstResponseDueAt) {
          updateData.firstResponseDueAt = new Date(ticket.firstResponseDueAt.getTime() + extendMs);
        }
        if (ticket.slaDeadline) {
          updateData.slaDeadline = new Date(ticket.slaDeadline.getTime() + extendMs);
        }
      }
    }
    if (input.priority) updateData.priority = input.priority;
    if (input.assigneeId !== undefined) updateData.assigneeId = input.assigneeId;
    if (input.queueId !== undefined) updateData.queueId = input.queueId;

    await this.db
      .update(supportTickets)
      .set(updateData)
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));

    await this.logTicketActivity(orgId, ticketId, userId, ticket, input);

    await this.invalidateTicketCaches(orgId);

    void this.realtime.publishTicketUpdated(orgId, ticketId, updateData.updatedAt as Date).catch(() => undefined);

    const updatedTicketForPayload = {
      id: ticketId,
      title: ticket.title,
      status: updateData.status ?? ticket.status,
      priority: updateData.priority ?? ticket.priority,
      category: ticket.category,
      assigneeId: updateData.assigneeId !== undefined ? updateData.assigneeId : ticket.assigneeId,
    };

    if (input.status && input.status !== ticket.status) {
      void this.automations
        .runAutomationsForEvent(orgId, "ticket.status_changed", this.buildAutomationPayload(updatedTicketForPayload))
        .catch(() => undefined);
    }
    if (input.priority && input.priority !== ticket.priority) {
      void this.automations
        .runAutomationsForEvent(orgId, "ticket.priority_changed", this.buildAutomationPayload(updatedTicketForPayload))
        .catch(() => undefined);
    }

    if (input.status === "RESOLVED" && ticket.status !== "RESOLVED") {
      void this.csat.createRequestForTicket(orgId, ticketId).catch(() => undefined);
    }

    if (input.status) {
      void this.notifications
        .sendStatusEmail(ticket.createdBy, userId, ticket.title, ticketId, input.status)
        .catch(() => undefined);
    }

    if (input.assigneeId && input.assigneeId !== ticket.assigneeId) {
      void this.notifications
        .sendAssignmentEmail(
          input.assigneeId,
          userId,
          ticket.title,
          ticket.priority ?? "MEDIUM",
          ticketId,
          "Support",
        )
        .catch(() => undefined);
    }

    return { success: true, updatedAt: updateData.updatedAt };
  }

  async listMessages(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    return this.db.query.supportTicketMessages.findMany({
      where: eq(supportTicketMessages.ticketId, ticketId),
      with: { author: { columns: { id: true, name: true, image: true } } },
      orderBy: [asc(supportTicketMessages.createdAt)],
    });
  }

  /**
   * Internal-note-safe read path: filters isInternal at the query level.
   * Not wired into any route yet — reserved for the future customer portal
   * so it never has to reach for listMessages()/getTicket(), which
   * intentionally include internal notes for agent-facing routes.
   */
  async listPublicMessages(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    return this.db.query.supportTicketMessages.findMany({
      where: and(
        eq(supportTicketMessages.ticketId, ticketId),
        eq(supportTicketMessages.isInternal, false),
      ),
      with: { author: { columns: { id: true, name: true, image: true } } },
      orderBy: [asc(supportTicketMessages.createdAt)],
    });
  }

  async addMessage(
    orgId: string,
    ticketId: number,
    userId: string | null,
    input: ReplyMessageInput,
    source?: { channel: string; messageId?: string | null; contactEmail?: string | null; contactName?: string | null },
  ) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: {
        id: true,
        status: true,
        title: true,
        createdBy: true,
        assigneeId: true,
        firstRespondedAt: true,
        priority: true,
        category: true,
      },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const [message] = await this.db
      .insert(supportTicketMessages)
      .values({
        ticketId,
        authorId: userId,
        body: input.body,
        isInternal: input.isInternal,
        attachments: input.attachments ?? [],
        sourceChannel: source?.channel ?? "web",
        sourceMessageId: source?.messageId ?? null,
        sourceContactEmail: source?.contactEmail ?? null,
        sourceContactName: source?.contactName ?? null,
      })
      .returning();

    await this.recordActivity(
      orgId,
      ticketId,
      userId,
      input.isInternal ? "internal_note" : "replied",
      null,
      null,
    );

    void this.realtime.publishMessageCreated(orgId, ticketId, message.id).catch(() => undefined);

    void this.automations
      .runAutomationsForEvent(orgId, "ticket.message_received", {
        ...this.buildAutomationPayload(ticket),
        isInternal: input.isInternal,
        messageBody: input.body,
      })
      .catch(() => undefined);

    const isFirstAgentReply =
      !input.isInternal && !ticket.firstRespondedAt && userId !== null && userId !== ticket.createdBy;

    if (ticket.status === "OPEN" || isFirstAgentReply) {
      const followUp: Partial<typeof supportTickets.$inferInsert> = { updatedAt: new Date() };
      if (ticket.status === "OPEN") followUp.status = "IN_PROGRESS";
      if (isFirstAgentReply) followUp.firstRespondedAt = new Date();
      await this.db
        .update(supportTickets)
        .set(followUp)
        .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));
    }

    if (!input.isInternal && userId) {
      void this.notifications
        .sendReplyEmail(
          { title: ticket.title, createdBy: ticket.createdBy, assigneeId: ticket.assigneeId },
          ticketId,
          userId,
          input.body,
        )
        .catch(() => undefined);
    }

    return message;
  }

  async listActivity(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const rows = await this.db
      .select({
        id: supportTicketActivity.id,
        action: supportTicketActivity.action,
        fromValue: supportTicketActivity.fromValue,
        toValue: supportTicketActivity.toValue,
        createdAt: supportTicketActivity.createdAt,
        userId: supportTicketActivity.userId,
        userName: users.name,
        userImage: users.image,
      })
      .from(supportTicketActivity)
      .leftJoin(users, eq(supportTicketActivity.userId, users.id))
      .where(
        and(
          eq(supportTicketActivity.supportTicketId, ticketId),
          eq(supportTicketActivity.orgId, orgId),
        ),
      )
      .orderBy(desc(supportTicketActivity.createdAt));

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      label: ACTION_LABELS[row.action] ?? row.action,
      fromValue: row.fromValue,
      toValue: row.toValue,
      createdAt: row.createdAt,
      userId: row.userId,
      userName: row.userName,
      userImage: row.userImage,
    }));
  }

  async addTicketLink(orgId: string, ticketId: number, userId: string, input: CreateTicketLinkInput) {
    if (input.linkedTicketId === ticketId) {
      throw new BadRequestException("A ticket cannot be linked to itself");
    }

    const [ticket, linkedTicket] = await Promise.all([
      this.db.query.supportTickets.findFirst({
        where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
        columns: { id: true },
      }),
      this.db.query.supportTickets.findFirst({
        where: and(eq(supportTickets.id, input.linkedTicketId), eq(supportTickets.orgId, orgId)),
        columns: { id: true },
      }),
    ]);
    if (!ticket) throw new NotFoundException("Ticket not found");
    if (!linkedTicket) throw new NotFoundException("Linked ticket not found");

    const [link] = await this.db
      .insert(supportTicketLinks)
      .values({
        orgId,
        ticketId,
        linkedTicketId: input.linkedTicketId,
        relation: input.relation,
        createdBy: userId,
      })
      .onConflictDoNothing()
      .returning();

    await this.recordActivity(orgId, ticketId, userId, "linked", null, String(input.linkedTicketId));

    return link ?? { success: true };
  }

  async listTicketLinks(orgId: string, ticketId: number) {
    await this.assertTicketExists(orgId, ticketId);
    return this.db.query.supportTicketLinks.findMany({
      where: and(eq(supportTicketLinks.orgId, orgId), eq(supportTicketLinks.ticketId, ticketId)),
      with: { linkedTicket: { columns: { id: true, title: true, status: true } } },
    });
  }

  async mergeTicket(orgId: string, ticketId: number, userId: string, input: MergeTicketInput) {
    if (input.intoTicketId === ticketId) {
      throw new BadRequestException("A ticket cannot be merged into itself");
    }

    const [ticket, targetTicket] = await Promise.all([
      this.db.query.supportTickets.findFirst({
        where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
        columns: { id: true, status: true, mergedIntoTicketId: true },
      }),
      this.db.query.supportTickets.findFirst({
        where: and(eq(supportTickets.id, input.intoTicketId), eq(supportTickets.orgId, orgId)),
        columns: { id: true },
      }),
    ]);
    if (!ticket) throw new NotFoundException("Ticket not found");
    if (!targetTicket) throw new NotFoundException("Target ticket not found");
    if (ticket.mergedIntoTicketId) {
      throw new ConflictException("This ticket has already been merged into another ticket");
    }

    await this.db
      .update(supportTickets)
      .set({ mergedIntoTicketId: input.intoTicketId, status: "CLOSED", closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));

    await this.recordActivity(orgId, ticketId, userId, "merged", ticket.status, String(input.intoTicketId));
    await this.invalidateTicketCaches(orgId);

    return { success: true, mergedIntoTicketId: input.intoTicketId };
  }

  private async assertTicketExists(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
  }

  async stats(orgId: string) {
    const now = new Date();
    const [statusAggs, slaBreached] = await Promise.all([
      this.db
        .select({ status: supportTickets.status, cnt: count() })
        .from(supportTickets)
        .where(eq(supportTickets.orgId, orgId))
        .groupBy(supportTickets.status),
      this.db
        .select({ cnt: count() })
        .from(supportTickets)
        .where(
          and(
            eq(supportTickets.orgId, orgId),
            sql`${supportTickets.slaDeadline} IS NOT NULL`,
            lt(supportTickets.slaDeadline, now),
            sql`${supportTickets.status} NOT IN ('RESOLVED', 'CLOSED')`,
          ),
        ),
    ]);

    const statusMap = new Map(statusAggs.map((r) => [r.status, Number(r.cnt)]));

    return {
      open: statusMap.get("OPEN") ?? 0,
      in_progress: statusMap.get("IN_PROGRESS") ?? 0,
      waiting: statusMap.get("WAITING") ?? 0,
      resolved: statusMap.get("RESOLVED") ?? 0,
      closed: statusMap.get("CLOSED") ?? 0,
      sla_breached: Number(slaBreached[0]?.cnt ?? 0),
    };
  }

  private async logTicketActivity(
    orgId: string,
    ticketId: number,
    userId: string,
    previous: { status: TicketStatus; priority: TicketPriority | null; assigneeId: string | null },
    input: UpdateTicketInput,
  ) {
    const entries: { action: TicketActivityAction; fromValue: string | null; toValue: string | null }[] = [];

    if (input.status && input.status !== previous.status) {
      const action: TicketActivityAction =
        input.status === "RESOLVED"
          ? "resolved"
          : (previous.status === "RESOLVED" || previous.status === "CLOSED") &&
              input.status !== "CLOSED"
            ? "reopened"
            : "status_changed";
      entries.push({ action, fromValue: previous.status, toValue: input.status });
    }

    if (input.priority && input.priority !== previous.priority) {
      entries.push({
        action: "priority_changed",
        fromValue: previous.priority,
        toValue: input.priority,
      });
    }

    if (input.assigneeId !== undefined && input.assigneeId !== (previous.assigneeId ?? "")) {
      entries.push({
        action: "assignee_changed",
        fromValue: previous.assigneeId,
        toValue: input.assigneeId || null,
      });
    }

    for (const entry of entries) {
      await this.recordActivity(orgId, ticketId, userId, entry.action, entry.fromValue, entry.toValue);
    }
  }

  /**
   * Fire-and-forget-on-failure activity log write, callable from any write
   * path (create/reply/update). Failures are caught and logged with full
   * context rather than failing the caller's request — a transient audit
   * insert failure shouldn't block an agent from replying to a customer.
   */
  private async recordActivity(
    orgId: string,
    ticketId: number,
    userId: string | null,
    action: TicketActivityAction,
    fromValue: string | null,
    toValue: string | null,
  ) {
    try {
      await this.db.insert(supportTicketActivity).values({
        orgId,
        supportTicketId: ticketId,
        userId,
        action,
        fromValue,
        toValue,
      });
    } catch (activityError) {
      logger.error("Failed to log support ticket activity", {
        orgId,
        ticketId,
        userId,
        action,
        fromValue,
        toValue,
        error: activityError instanceof Error ? activityError.message : String(activityError),
      });
    }
  }

  private async invalidateTicketCaches(orgId: string) {
    await this.cache.invalidatePattern(`support:tickets:${orgId}:*`);
    await this.cache.invalidate(CACHE_KEYS.supportDashboard(orgId));
    await this.cache.invalidate(CACHE_KEYS.ceDashboard(orgId));
  }
}
