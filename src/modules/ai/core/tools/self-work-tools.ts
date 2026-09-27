import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import {
  activities,
  candidateApplications,
  candidateReferrals,
  candidates,
  interviews,
  jobPostings,
  timesheets,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { ProjectsWorkQueryService } from "../../../build/core";
import {
  defineTool,
  data,
  empty,
} from "../registry/ask-os-tool.types";
import type {
  AskOsToolDefinition,
  AskOsToolProvider,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";
import { REFERRAL_CAP } from "./lib/tool-read-caps";


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

@AskOsTools()
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
      this.buildGetMyJobApplications(),
      this.buildGetMyInterviews(),
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
        "Returns a breakdown of the caller's tickets by status (scope: mine). Counts co-assigned tickets via the union path. Counts are exact and not capped.",
      input: z.object({}),
      permission: "build:tickets:view",
      module: "build",
      run: async (_input, ctx) => {
        const { byStatus, total } = await this.projectsWorkQuery.countTicketsByStatus(ctx.caller, {
          scope: "mine",
        });
        if (total === 0) return empty("tickets");
        return data({ byStatus, total });
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
        "Lists candidate referrals submitted by the caller. When atCap is true the list is truncated and count ends in '+', so report it as a lower bound rather than an exact figure.",
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
      description: "Lists open CRM tasks assigned to the caller, ordered by due date with undated tasks last.",
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

  private buildGetMyJobApplications(): AskOsToolDefinition {
    return defineTool({
      key: "getMyJobApplications",
      description:
        "Lists the caller's own applications to internal job openings, most recent first. Returns up to 20 records; capped is true when more may exist.",
      input: z.object({}),
      permission: "self:job-openings",
      module: "hr",
      run: async (_input, ctx) => {
        const { orgId, email } = ctx.actor;
        const rows = await this.db
          .select({
            applicationId: candidateApplications.id,
            status: candidateApplications.status,
            appliedAt: candidateApplications.appliedAt,
            jobTitle: jobPostings.title,
            jobType: jobPostings.type,
            jobLocation: jobPostings.location,
          })
          .from(candidates)
          .innerJoin(
            candidateApplications,
            and(
              eq(candidateApplications.orgId, candidates.orgId),
              eq(candidateApplications.candidateId, candidates.id),
            ),
          )
          .innerJoin(
            jobPostings,
            and(
              eq(jobPostings.orgId, candidateApplications.orgId),
              eq(jobPostings.id, candidateApplications.jobPostingId),
              eq(jobPostings.isInternal, true),
            ),
          )
          .where(
            and(
              eq(candidates.orgId, orgId),
              eq(candidates.email, email),
            ),
          )
          .orderBy(desc(candidateApplications.appliedAt))
          .limit(20);

        if (rows.length === 0) return empty("job applications");
        return data({ applications: rows, total: rows.length, capped: rows.length === 20 });
      },
    });
  }

  private buildGetMyInterviews(): AskOsToolDefinition {
    return defineTool({
      key: "getMyInterviews",
      description:
        "Lists the caller's own scheduled interviews as the interviewee (candidate) in internal job openings, most recent first. Never returns other candidates' interviews or the hiring pipeline.",
      input: z.object({}),
      permission: "self:recruitment",
      module: "hr",
      run: async (_input, ctx) => {
        const { orgId, email } = ctx.actor;
        const rows = await this.db
          .select({
            interviewId: interviews.id,
            type: interviews.type,
            scheduledAt: interviews.scheduledAt,
            durationMinutes: interviews.duration,
            meetingLink: interviews.meetingLink,
            location: interviews.location,
            result: interviews.result,
            jobTitle: jobPostings.title,
          })
          .from(candidates)
          .innerJoin(
            interviews,
            and(
              eq(interviews.orgId, candidates.orgId),
              eq(interviews.candidateId, candidates.id),
            ),
          )
          .leftJoin(
            jobPostings,
            and(
              eq(jobPostings.orgId, interviews.orgId),
              eq(jobPostings.id, interviews.jobPostingId),
            ),
          )
          .where(
            and(
              eq(candidates.orgId, orgId),
              eq(candidates.email, email),
            ),
          )
          .orderBy(desc(interviews.scheduledAt))
          .limit(20);

        if (rows.length === 0) return empty("interviews");
        return data({ interviews: rows, total: rows.length, capped: rows.length === 20 });
      },
    });
  }
}
