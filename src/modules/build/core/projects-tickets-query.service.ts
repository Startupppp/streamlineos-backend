import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import {
  projectMembers,
  tickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { CacheService } from "../../../common/cache/cache.service";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { resolveValidTicketStatuses } from "./ticket-status.util";
import { ProjectsInvalidTicketStatusException } from "../../../common/http/api-exceptions";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { BulkUpdateInput, RankTicketInput } from "./dto/projects.schemas";
import {
  assertTransitionAllowed as assertTransitionAllowedFn,
  assertWipLimit as assertWipLimitFn,
  enforceWipLimitForStatus as enforceWipLimitForStatusFn,
  type PrefetchedWorkflow,
} from "./projects-tickets-workflow-utils";
import {
  rankTicket as rankTicketFn,
  rebalanceProjectRanks as rebalanceProjectRanksFn,
} from "./projects-tickets-rank-utils";

@Injectable()
export class ProjectsTicketsQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async validateTicketStatus(
    projectId: number,
    orgId: string,
    status: string,
  ): Promise<void> {
    const valid = await resolveValidTicketStatuses(this.db, projectId, orgId);
    if (!valid.has(status))
      throw new ProjectsInvalidTicketStatusException(status);
  }

  async assertTransitionAllowed(
    orgId: string,
    projectId: number,
    fromText: string,
    toText: string,
    context: {
      userId: string;
      userProjectRole: string | null;
      isOrgOwner: boolean;
      ticketId: number;
    },
    prefetched?: PrefetchedWorkflow,
  ): Promise<void> {
    return assertTransitionAllowedFn(
      this.db,
      orgId,
      projectId,
      fromText,
      toText,
      context,
      prefetched,
    );
  }

  async assertWipLimit(
    orgId: string,
    projectId: number,
    statusName: string,
    wipLimit: number,
    excludeTicketId?: number,
  ): Promise<void> {
    return assertWipLimitFn(
      this.db,
      orgId,
      projectId,
      statusName,
      wipLimit,
      excludeTicketId,
    );
  }

  async enforceWipLimitForStatus(
    orgId: string,
    projectId: number,
    statusName: string,
    excludeTicketId: number,
  ): Promise<void> {
    return enforceWipLimitForStatusFn(
      this.db,
      orgId,
      projectId,
      statusName,
      excludeTicketId,
    );
  }

  async bulkUpdate(
    u: CurrentUserContext,
    projectId: number,
    body: BulkUpdateInput,
  ) {
    if (!u.isOrgOwner) {
      const member = await this.db.query.projectMembers.findFirst({
        where: and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, u.userId),
        ),
        columns: { id: true },
      });
      if (!member) throw new ForbiddenException("Not a project member.");
    }

    let updated: Array<{ id: number }> = [];

    await this.db.transaction(async (tx) => {
      const found = await tx
        .select({ id: tickets.id })
        .from(tickets)
        .where(
          and(
            eq(tickets.orgId, u.orgId),
            eq(tickets.projectId, projectId),
            inArray(tickets.id, body.ticketIds),
            isNull(tickets.deletedAt),
          ),
        );

      if (found.length !== body.ticketIds.length)
        throw new NotFoundException("One or more ticket IDs not found in this project");

      if (body.status !== undefined) {
        const valid = await resolveValidTicketStatuses(tx, projectId, u.orgId);
        if (!valid.has(body.status))
          throw new ProjectsInvalidTicketStatusException(body.status);
      }

      if (body.parentTicketId != null) {
        const selectedSet = new Set(body.ticketIds);

        if (selectedSet.has(body.parentTicketId))
          throw new BadRequestException("Cannot set a ticket as its own parent.");

        const parentRow = await tx
          .select({
            id: tickets.id,
            projectId: tickets.projectId,
          })
          .from(tickets)
          .where(
            and(
              eq(tickets.id, body.parentTicketId),
              eq(tickets.orgId, u.orgId),
              isNull(tickets.deletedAt),
            ),
          )
          .limit(1);

        if (parentRow.length === 0)
          throw new NotFoundException("Parent ticket not found.");

        if (parentRow[0]?.projectId !== projectId)
          throw new BadRequestException("Parent ticket must belong to the same project.");

        const ancestorCheck = await tx.execute(sql`
          WITH RECURSIVE ancestors AS (
            SELECT id, parent_ticket_id
            FROM build.tickets
            WHERE id = ${parentRow[0].id} AND org_id = ${u.orgId}
            UNION ALL
            SELECT t.id, t.parent_ticket_id
            FROM build.tickets t
            INNER JOIN ancestors a ON t.id = a.parent_ticket_id
            WHERE t.org_id = ${u.orgId}
          )
          SELECT count(*)::text AS count FROM ancestors
          WHERE id IN (${sql.join(
            body.ticketIds.map((id) => sql`${id}`),
            sql`, `,
          )})
        `);
        if (Number(ancestorCheck[0]?.["count"] ?? "0") > 0)
          throw new BadRequestException("Cannot set parent: this would create a cycle.");
      }

      const updateData: Partial<typeof tickets.$inferInsert> = { updatedAt: new Date() };
      if (body.assigneeId !== undefined) updateData.assigneeId = body.assigneeId;
      if (body.status !== undefined) updateData.status = body.status;
      if (body.sprintId !== undefined) updateData.sprintId = body.sprintId;
      if (body.priority !== undefined) updateData.priority = body.priority;
      if (body.parentTicketId !== undefined) updateData.parentTicketId = body.parentTicketId;

      updated = await tx
        .update(tickets)
        .set(updateData)
        .where(
          and(
            eq(tickets.orgId, u.orgId),
            eq(tickets.projectId, projectId),
            inArray(tickets.id, body.ticketIds),
            isNull(tickets.deletedAt),
          ),
        )
        .returning({ id: tickets.id });
    });

    void this.cache
      .del(`projects:analytics:${u.orgId}:${projectId}`)
      .catch(logSideEffectFailure("analytics cache eviction", { orgId: u.orgId, projectId }));

    return { updated: updated.length, ticketIds: updated.map((t) => t.id) };
  }

  async rankTicket(
    orgId: string,
    projectId: number,
    ticketId: number,
    body: RankTicketInput,
    context: { userId: string; isOrgOwner: boolean },
  ) {
    return rankTicketFn(
      this.db,
      this.cache,
      orgId,
      projectId,
      ticketId,
      body,
      context,
    );
  }

  async rebalanceProjectRanks(orgId: string, projectId: number): Promise<void> {
    return rebalanceProjectRanksFn(this.db, orgId, projectId);
  }
}
