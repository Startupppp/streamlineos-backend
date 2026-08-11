import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import {
  projectMembers,
  projectStatuses,
  tickets,
  workflowTransitions,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { resolveValidTicketStatuses } from "./ticket-status.util";
import { ProjectsInvalidTicketStatusException } from "../../../common/http/api-exceptions";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { BulkUpdateInput, RankTicketInput } from "./dto/projects.schemas";

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

  private async fetchTransitionsAndStatuses(orgId: string, projectId: number) {
    try {
      const [transitions, statuses] = await Promise.all([
        this.db
          .select({
            fromStatusId: workflowTransitions.fromStatusId,
            toStatusId: workflowTransitions.toStatusId,
            requiresApproval: workflowTransitions.requiresApproval,
            requiredFields: workflowTransitions.requiredFields,
            allowedRoles: workflowTransitions.allowedRoles,
          })
          .from(workflowTransitions)
          .where(
            and(
              eq(workflowTransitions.orgId, orgId),
              eq(workflowTransitions.projectId, projectId),
              isNull(workflowTransitions.deletedAt),
            ),
          ),
        this.db
          .select({
            id: projectStatuses.id,
            name: projectStatuses.name,
            wipLimit: projectStatuses.wipLimit,
          })
          .from(projectStatuses)
          .where(
            and(
              eq(projectStatuses.orgId, orgId),
              eq(projectStatuses.projectId, projectId),
            ),
          ),
      ]);
      return { transitions, statuses };
    } catch {
      const transitions: {
        fromStatusId: number | null;
        toStatusId: number;
        requiresApproval: boolean | null;
        requiredFields: string[] | null;
        allowedRoles: string[] | null;
      }[] = [];
      const statuses: { id: number; name: string; wipLimit: number | null }[] =
        [];
      return { transitions, statuses };
    }
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
    prefetched?: {
      transitions: {
        fromStatusId: number | null;
        toStatusId: number;
        requiresApproval: boolean | null;
        requiredFields: string[] | null;
        allowedRoles: string[] | null;
      }[];
      statuses: { id: number; name: string; wipLimit: number | null }[];
    },
  ): Promise<void> {
    const { transitions, statuses } =
      prefetched ?? (await this.fetchTransitionsAndStatuses(orgId, projectId));

    if (transitions.length === 0) return;

    const nameToId = new Map(statuses.map((s) => [s.name, s.id]));
    const idToStatus = new Map(statuses.map((s) => [s.id, s]));

    const resolvedFrom = nameToId.get(fromText);
    const resolvedTo = nameToId.get(toText);

    if (resolvedFrom === undefined || resolvedTo === undefined) return;

    const matchingTransitions = transitions.filter(
      (t) =>
        t.toStatusId === resolvedTo &&
        (t.fromStatusId === resolvedFrom || t.fromStatusId === null),
    );

    if (matchingTransitions.length === 0) {
      throw new BadRequestException(
        `Transition from '${fromText}' to '${toText}' is not allowed by this project's workflow.`,
      );
    }

    const bypassPrivilege = context.isOrgOwner;

    for (const transition of matchingTransitions) {
      if (transition.requiresApproval && !bypassPrivilege) {
        throw new BadRequestException(
          `This transition requires approval before moving to '${toText}'. Submit an approval request first.`,
        );
      }

      if (
        Array.isArray(transition.allowedRoles) &&
        transition.allowedRoles.length > 0 &&
        !bypassPrivilege
      ) {
        if (
          !context.userProjectRole ||
          !transition.allowedRoles.includes(context.userProjectRole)
        ) {
          throw new BadRequestException(
            `Your project role ('${context.userProjectRole ?? "unknown"}') is not allowed to make this transition.`,
          );
        }
      }

      if (
        Array.isArray(transition.requiredFields) &&
        transition.requiredFields.length > 0
      ) {
        const ticketRows = await this.db
          .select({
            assigneeId: tickets.assigneeId,
            dueDate: tickets.dueDate,
            priority: tickets.priority,
            points: tickets.points,
            epicId: tickets.epicId,
            sprintId: tickets.sprintId,
          })
          .from(tickets)
          .where(
            and(eq(tickets.id, context.ticketId), eq(tickets.orgId, orgId)),
          )
          .limit(1);

        if (ticketRows.length > 0) {
          const row = ticketRows[0];
          const missing: string[] = [];
          for (const field of transition.requiredFields) {
            if (field === "assigneeId" && !row.assigneeId) missing.push(field);
            else if (field === "dueDate" && !row.dueDate) missing.push(field);
            else if (field === "priority" && !row.priority) missing.push(field);
            else if (
              field === "points" &&
              (row.points === null || row.points === undefined)
            )
              missing.push(field);
            else if (field === "epicId" && !row.epicId) missing.push(field);
            else if (field === "sprintId" && !row.sprintId) missing.push(field);
          }
          if (missing.length > 0) {
            throw new BadRequestException(
              `Cannot move to '${toText}': the following fields are required: ${missing.join(", ")}.`,
            );
          }
        }
      }
    }

    const toStatus = idToStatus.get(resolvedTo);
    if (toStatus?.wipLimit != null) {
      await this.assertWipLimit(
        orgId,
        projectId,
        toText,
        toStatus.wipLimit,
        context.ticketId,
      );
    }
  }

  async assertWipLimit(
    orgId: string,
    projectId: number,
    statusName: string,
    wipLimit: number,
    excludeTicketId?: number,
  ): Promise<void> {
    const conditions = [
      eq(tickets.orgId, orgId),
      eq(tickets.projectId, projectId),
      eq(tickets.status, statusName),
    ];
    if (excludeTicketId !== undefined) {
      conditions.push(ne(tickets.id, excludeTicketId));
    }
    const [countResult] = await this.db
      .select({ cnt: count() })
      .from(tickets)
      .where(and(...conditions));
    const currentCount = Number(countResult?.cnt ?? 0);
    if (currentCount >= wipLimit) {
      throw new ConflictException(
        `Column '${statusName}' is at its WIP limit of ${wipLimit}. Move or complete an existing ticket first.`,
      );
    }
  }

  async enforceWipLimitForStatus(
    orgId: string,
    projectId: number,
    statusName: string,
    excludeTicketId: number,
  ): Promise<void> {
    const rows = await this.db
      .select({
        wipLimit: projectStatuses.wipLimit,
        name: projectStatuses.name,
      })
      .from(projectStatuses)
      .where(
        and(
          eq(projectStatuses.orgId, orgId),
          eq(projectStatuses.projectId, projectId),
          eq(projectStatuses.name, statusName),
        ),
      )
      .limit(1);
    const wipLimit = rows[0]?.wipLimit;
    if (wipLimit == null) return;
    await this.assertWipLimit(
      orgId,
      projectId,
      statusName,
      wipLimit,
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
      });
      if (!member) throw new ForbiddenException("Not a project member.");
    }

    if (body.status !== undefined) {
      await this.validateTicketStatus(projectId, u.orgId, body.status);
    }

    if (body.parentTicketId != null) {
      const selectedSet = new Set(body.ticketIds);

      if (selectedSet.has(body.parentTicketId)) {
        throw new BadRequestException("Cannot set a ticket as its own parent.");
      }

      const parentRow = await this.db
        .select({
          id: tickets.id,
          projectId: tickets.projectId,
          parentTicketId: tickets.parentTicketId,
        })
        .from(tickets)
        .where(
          and(eq(tickets.id, body.parentTicketId), eq(tickets.orgId, u.orgId)),
        )
        .limit(1);

      if (parentRow.length === 0) {
        throw new NotFoundException("Parent ticket not found.");
      }

      if (parentRow[0]?.projectId !== projectId) {
        throw new BadRequestException(
          "Parent ticket must belong to the same project.",
        );
      }

      const ancestorCheck = await this.db.execute(sql`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_ticket_id
          FROM tickets
          WHERE id = ${parentRow[0].id} AND org_id = ${u.orgId}
          UNION ALL
          SELECT t.id, t.parent_ticket_id
          FROM tickets t
          INNER JOIN ancestors a ON t.id = a.parent_ticket_id
          WHERE t.org_id = ${u.orgId}
        )
        SELECT count(*)::text AS count FROM ancestors
        WHERE id IN (${sql.join(
          body.ticketIds.map((id) => sql`${id}`),
          sql`, `,
        )})
      `);
      if (Number(ancestorCheck[0]?.["count"] ?? "0") > 0) {
        throw new BadRequestException(
          "Cannot set parent: this would create a cycle.",
        );
      }
    }

    const updateData: Partial<typeof tickets.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (body.assigneeId !== undefined) updateData.assigneeId = body.assigneeId;
    if (body.status !== undefined) updateData.status = body.status;
    if (body.sprintId !== undefined) updateData.sprintId = body.sprintId;
    if (body.priority !== undefined) updateData.priority = body.priority;
    if (body.parentTicketId !== undefined)
      updateData.parentTicketId = body.parentTicketId;

    const updated = await this.db
      .update(tickets)
      .set(updateData)
      .where(
        and(
          eq(tickets.orgId, u.orgId),
          eq(tickets.projectId, projectId),
          inArray(tickets.id, body.ticketIds),
        ),
      )
      .returning({ id: tickets.id });

    void this.cache
      .del(`projects:analytics:${u.orgId}:${projectId}`)
      .catch(() => undefined);

    return { updated: updated.length, ticketIds: updated.map((t) => t.id) };
  }

  async rankTicket(
    orgId: string,
    projectId: number,
    ticketId: number,
    body: RankTicketInput,
    context: { userId: string; isOrgOwner: boolean },
  ) {
    const [targetRow] = await this.db
      .select({ id: tickets.id, status: tickets.status, rank: tickets.rank })
      .from(tickets)
      .where(
        and(
          eq(tickets.id, ticketId),
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
        ),
      )
      .limit(1);
    if (!targetRow) throw new NotFoundException("Ticket not found");

    let beforeRank: number | null = null;
    let afterRank: number | null = null;

    if (body.beforeTicketId != null) {
      const [row] = await this.db
        .select({ rank: tickets.rank })
        .from(tickets)
        .where(
          and(
            eq(tickets.id, body.beforeTicketId),
            eq(tickets.orgId, orgId),
            eq(tickets.projectId, projectId),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundException("Neighbour ticket not found");
      beforeRank = Number(row.rank);
    }

    if (body.afterTicketId != null) {
      const [row] = await this.db
        .select({ rank: tickets.rank })
        .from(tickets)
        .where(
          and(
            eq(tickets.id, body.afterTicketId),
            eq(tickets.orgId, orgId),
            eq(tickets.projectId, projectId),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundException("Neighbour ticket not found");
      afterRank = Number(row.rank);
    }

    let newRank: number;
    if (beforeRank !== null && afterRank !== null)
      newRank = (beforeRank + afterRank) / 2;
    else if (afterRank !== null) newRank = afterRank - 1000;
    else if (beforeRank !== null) newRank = beforeRank + 1000;
    else newRank = 1000;

    const newStatus = body.status ?? targetRow.status;
    const statusChanging =
      body.status !== undefined && body.status !== targetRow.status;

    if (statusChanging) {
      const [memberRow] = await this.db
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, context.userId),
          ),
        )
        .limit(1);
      const userProjectRole = memberRow?.role ?? null;

      await this.assertTransitionAllowed(
        orgId,
        projectId,
        targetRow.status,
        newStatus,
        {
          userId: context.userId,
          userProjectRole,
          isOrgOwner: context.isOrgOwner,
          ticketId,
        },
      );
    }

    const [updated] = await this.db
      .update(tickets)
      .set({ rank: String(newRank), status: newStatus, updatedAt: new Date() })
      .where(
        and(
          eq(tickets.id, ticketId),
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
        ),
      )
      .returning({
        id: tickets.id,
        rank: tickets.rank,
        status: tickets.status,
      });

    if (!updated) throw new NotFoundException("Ticket not found");

    if (statusChanging) {
      void this.cache
        .del(`projects:analytics:${orgId}:${projectId}`)
        .catch(() => undefined);
    }

    const scale = decimalScale(newRank);
    if (scale > REBALANCE_SCALE_THRESHOLD) {
      void this.rebalanceProjectRanks(orgId, projectId).catch(() => undefined);
    }

    return { id: updated.id, rank: updated.rank, status: updated.status };
  }

  async rebalanceProjectRanks(orgId: string, projectId: number): Promise<void> {
    const MAX_TICKETS = 10_000;

    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.orgId, orgId), eq(tickets.projectId, projectId)))
        .orderBy(asc(tickets.rank), desc(tickets.createdAt), asc(tickets.id))
        .limit(MAX_TICKETS);

      if (rows.length === 0) return;

      const ids = rows.map((r) => r.id);
      const cases = rows.map(
        (r, i) => sql`WHEN ${r.id} THEN ${String((i + 1) * 1000)}`,
      );
      await tx
        .update(tickets)
        .set({ rank: sql`(CASE ${tickets.id} ${sql.join(cases, sql` `)} END)` })
        .where(
          and(
            eq(tickets.orgId, orgId),
            eq(tickets.projectId, projectId),
            inArray(tickets.id, ids),
          ),
        );
    });
  }
}

const REBALANCE_SCALE_THRESHOLD = 20;

function decimalScale(n: number): number {
  const s = n.toString();
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}
