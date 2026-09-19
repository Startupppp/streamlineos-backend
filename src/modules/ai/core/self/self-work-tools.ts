import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { activities, candidateReferrals, timesheets } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { ProjectsWorkQueryService } from "../../../build/core/projects-work-query.service";
import {
  defineTool,
  data,
  empty,
} from "../registry/ask-os-tool.types";
import type {
  AskOsToolDefinition,
  AskOsToolProvider,
} from "../registry/ask-os-tool.types";

const REFERRAL_CAP = 200;

type WorkRow = Awaited<
  ReturnType<ProjectsWorkQueryService["getAllWork"]>
>["data"][number];

function projectWorkRow(row: WorkRow, includeAssignee: boolean): Record<string, unknown> {
  return {
    id: row.id,
    ref: row.projectKey && row.ticketNumber ? `${row.projectKey}-${String(row.ticketNumber)}` : null,
    title: row.title,
    status: row.status,
    priority: row.priority,
    type: row.type,
    dueDate: row.dueDate,
    project: row.projectName,
    ...(includeAssignee ? { assignee: row.assignee?.name ?? null } : {}),
  };
}

@Injectable()
export class SelfWorkTools implements AskOsToolProvider {
  constructor(
    private readonly projectsWorkQuery: ProjectsWorkQueryService,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  tools(): AskOsToolDefinition[] {
    return [
      this.buildGetMyTickets(),
      this.buildGetMyTicketStats(),
      this.buildGetMyCreatedTickets(),
      this.buildGetMyReferrals(),
      this.buildGetMyTasks(),
      this.buildGetMyTimesheets(),
    ];
  }

  private buildGetMyTickets(): AskOsToolDefinition {
    return defineTool({
      key: "getMyTickets",
      description:
        "Lists tickets assigned to or co-assigned with the caller (scope: mine). Includes tickets from the ticket_assignees multi-assignee table so co-assigned work is never missed. Use this to answer 'what tickets have I handled?' or 'how many tickets am I working on?'.",
      input: z.object({
        status: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).default(25),
      }),
      permission: "build:tickets:view",
      module: "build",
      run: async (input, ctx) => {
        const result = await this.projectsWorkQuery.getAllWork(ctx.caller, {
          scope: "mine",
          limit: input.limit,
          orderBy: "rank",
          status: input.status,
          priority: undefined,
          type: undefined,
          assigneeId: undefined,
          labelIds: undefined,
          cycleId: undefined,
          excludeStatus: undefined,
          projectIds: undefined,
        });
        if (result.data.length === 0) return empty("tickets");
        return data({
          tickets: result.data.map((row) => projectWorkRow(row, false)),
          total: result.total,
          hasMore: result.hasMore,
        });
      },
    });
  }

  private buildGetMyTicketStats(): AskOsToolDefinition {
    return defineTool({
      key: "getMyTicketStats",
      description:
        "Returns a breakdown of the caller's tickets by status (scope: mine). Counts co-assigned tickets via the union path. When hasMore is true, partial is set and the total may understate the real figure.",
      input: z.object({}),
      permission: "build:tickets:view",
      module: "build",
      run: async (_input, ctx) => {
        const result = await this.projectsWorkQuery.getAllWork(ctx.caller, {
          scope: "mine",
          limit: 100,
          orderBy: "rank",
          status: undefined,
          priority: undefined,
          type: undefined,
          assigneeId: undefined,
          labelIds: undefined,
          cycleId: undefined,
          excludeStatus: undefined,
          projectIds: undefined,
        });
        const byStatus: Record<string, number> = {};
        for (const ticket of result.data) {
          byStatus[ticket.status] = (byStatus[ticket.status] ?? 0) + 1;
        }
        return data({
          byStatus,
          total: result.total,
          partial: result.hasMore,
        });
      },
    });
  }

  private buildGetMyCreatedTickets(): AskOsToolDefinition {
    return defineTool({
      key: "getMyCreatedTickets",
      description: "Lists tickets created by the caller.",
      input: z.object({
        limit: z.number().int().min(1).max(50).default(25),
      }),
      permission: "build:tickets:view",
      module: "build",
      run: async (input, ctx) => {
        const result = await this.projectsWorkQuery.getAllWork(ctx.caller, {
          scope: "created",
          limit: input.limit,
          orderBy: "created",
          status: undefined,
          priority: undefined,
          type: undefined,
          assigneeId: undefined,
          labelIds: undefined,
          cycleId: undefined,
          excludeStatus: undefined,
          projectIds: undefined,
        });
        if (result.data.length === 0) return empty("created tickets");
        return data({
          tickets: result.data.map((row) => projectWorkRow(row, true)),
          total: result.total,
          hasMore: result.hasMore,
        });
      },
    });
  }

  private buildGetMyReferrals(): AskOsToolDefinition {
    return defineTool({
      key: "getMyReferrals",
      description:
        "Lists candidate referrals submitted by the caller. The data source caps at 200 rows with no server-side total — when count is '200+' the real number may be higher and the caller should say so rather than citing 200 as an exact figure.",
      input: z.object({}),
      permission: "self:referrals",
      module: "hr",
      run: async (_input, ctx) => {
        const rows = await this.db
          .select({
            id: candidateReferrals.id,
            candidateId: candidateReferrals.candidateId,
            status: candidateReferrals.status,
            jobPostingId: candidateReferrals.jobPostingId,
            createdAt: candidateReferrals.createdAt,
          })
          .from(candidateReferrals)
          .where(
            and(
              eq(candidateReferrals.orgId, ctx.actor.orgId),
              eq(candidateReferrals.referredByMembershipId, ctx.actor.membershipId),
            ),
          )
          .orderBy(desc(candidateReferrals.createdAt))
          .limit(REFERRAL_CAP);
        if (rows.length === 0) return empty("referrals");
        const atCap = rows.length >= REFERRAL_CAP;
        return data({
          referrals: rows,
          count: atCap ? `${REFERRAL_CAP}+` : rows.length,
          atCap,
        });
      },
    });
  }

  private buildGetMyTasks(): AskOsToolDefinition {
    return defineTool({
      key: "getMyTasks",
      description: "Lists open CRM tasks assigned to the caller, ordered by due date (nulls last). Mirrors the predicates of MyTasksService: kind = task, deleted_at IS NULL, completed_at IS NULL, assignee_user_id = caller.",
      input: z.object({
        limit: z.number().int().min(1).max(50).default(25),
      }),
      permission: "crm:activities:view",
      module: "crm",
      run: async (input, ctx) => {
        const rows = await this.db
          .select({
            activityId: activities.activityId,
            subject: activities.subject,
            dueAt: activities.dueAt,
            occurredAt: activities.occurredAt,
            completedAt: activities.completedAt,
          })
          .from(activities)
          .where(
            and(
              eq(activities.organizationId, ctx.actor.orgId),
              isNull(activities.deletedAt),
              eq(activities.kind, "task"),
              eq(activities.assigneeUserId, ctx.actor.userId),
              isNull(activities.completedAt),
            ),
          )
          .orderBy(
            sql`${activities.dueAt} is null`,
            asc(activities.dueAt),
            asc(activities.activityId),
          )
          .limit(input.limit);
        if (rows.length === 0) return empty("tasks");
        return data({ tasks: rows });
      },
    });
  }

  private buildGetMyTimesheets(): AskOsToolDefinition {
    return defineTool({
      key: "getMyTimesheets",
      description:
        "Lists the caller's timesheet entries for a date range. Defaults to the current month from the caller's timezone. Only returns non-voided entries scoped to the caller's membership.",
      input: z.object({
        from: z.string().optional(),
        to: z.string().optional(),
      }),
      permission: "timesheets:entries:view",
      module: "timesheets",
      run: async (input, ctx) => {
        const from = input.from ?? ctx.actor.monthStart;
        const to = input.to ?? ctx.actor.monthEnd;
        const rows = await this.db
          .select({
            id: timesheets.id,
            date: timesheets.date,
            hours: timesheets.hours,
            description: timesheets.description,
            status: timesheets.status,
            projectId: timesheets.projectId,
            isBillable: timesheets.isBillable,
          })
          .from(timesheets)
          .where(
            and(
              eq(timesheets.orgId, ctx.actor.orgId),
              eq(timesheets.userMembershipId, ctx.actor.membershipId),
              isNull(timesheets.voidedAt),
              gte(timesheets.date, from),
              lte(timesheets.date, to),
            ),
          )
          .orderBy(desc(timesheets.date))
          .limit(100);
        if (rows.length === 0) return empty("timesheet entries", `No entries found between ${from} and ${to}.`);
        return data({ entries: rows, from, to });
      },
    });
  }
}
