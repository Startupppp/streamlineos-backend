import { Injectable, Inject } from "@nestjs/common";
import { tool } from "ai";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { organizationMembers, tickets, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { ToolAccessService } from "./tool-access.service";
import { CalendarService } from "../../calendar/calendar.service";
import { ChatSearchService } from "../../chat/chat-search.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

export interface WorkspaceCopilotContext {
  actor: CurrentUserContext;
}

@Injectable()
export class WorkspaceCopilotTools {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly toolAccess: ToolAccessService,
    private readonly calendar: CalendarService,
    private readonly chatSearch: ChatSearchService,
  ) {}

  buildTools(ctx: WorkspaceCopilotContext) {
    const { actor } = ctx;
    const { orgId, userId } = actor;

    return {
      findPerson: tool({
        description:
          "Resolve a person's name to org members matching that name. Returns up to 5 matches with id, name, email. Call this first before getPersonTicketStats when the user mentions someone by name.",
        inputSchema: z.object({
          name: z.string().min(1).describe("Full or partial name to search"),
        }),
        execute: async ({ name }) => {
          const q = `%${name.trim()}%`;
          const rows = await this.db
            .select({
              id: users.id,
              name: users.name,
              firstName: users.firstName,
              lastName: users.lastName,
              email: users.email,
            })
            .from(organizationMembers)
            .innerJoin(users, eq(organizationMembers.userId, users.id))
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(users.isActive, true),
                sql`(
                  ${users.name} ILIKE ${q}
                  OR CONCAT(${users.firstName}, ' ', ${users.lastName}) ILIKE ${q}
                  OR ${users.email} ILIKE ${q}
                )`,
              ),
            )
            .limit(5);

          if (rows.length === 0) return { results: [], message: `No org members found matching "${name}".` };

          return {
            results: rows.map((r) => ({
              id: r.id,
              name: r.name ?? `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
              email: r.email ?? "",
            })),
            message: `Found ${rows.length} member(s).`,
          };
        },
      }),

      getPersonTicketStats: tool({
        description:
          "Get ticket statistics for a specific org member. ALWAYS call findPerson first to get the userId from their name. Returns per-project totals (total, done, inProgress) plus cross-project summary.",
        inputSchema: z.object({
          userId: z.string().describe("The user ID obtained from findPerson"),
          projectId: z.number().int().positive().optional().describe("Filter to a specific project ID"),
        }),
        execute: async ({ userId: targetUserId, projectId }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "build:tickets:view");
          if (deny) return { denied: true, reason: deny };

          const scope = await this.toolAccess.scope(orgId, userId, "build:tickets:view");
          if (scope === "own" && targetUserId !== userId) {
            return { denied: true, reason: "Permission denied: you can only view your own ticket stats." };
          }

          const conditions = [
            eq(tickets.orgId, orgId),
            eq(tickets.assigneeId, targetUserId),
          ];
          if (projectId !== undefined) conditions.push(eq(tickets.projectId, projectId));

          const rows = await this.db.execute<{
            project_id: number | null;
            project_name: string | null;
            total: string;
            done: string;
            in_progress: string;
          }>(sql`
            SELECT
              t.project_id,
              p.name AS project_name,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE t.status = 'DONE') AS done,
              COUNT(*) FILTER (WHERE t.status IN ('IN_PROGRESS','IN_REVIEW')) AS in_progress
            FROM tickets t
            LEFT JOIN projects p ON p.id = t.project_id
            WHERE t.org_id = ${orgId}
              AND t.assignee_id = ${targetUserId}
              ${projectId !== undefined ? sql`AND t.project_id = ${projectId}` : sql``}
            GROUP BY t.project_id, p.name
            ORDER BY COUNT(*) DESC
            LIMIT 50
          `);

          const byProject = rows.map((r) => ({
            projectId: r.project_id,
            projectName: r.project_name ?? "Unassigned",
            total: Number(r.total),
            done: Number(r.done),
            inProgress: Number(r.in_progress),
          }));

          const totals = byProject.reduce(
            (acc, r) => ({
              total: acc.total + r.total,
              done: acc.done + r.done,
              inProgress: acc.inProgress + r.inProgress,
            }),
            { total: 0, done: 0, inProgress: 0 },
          );

          return { byProject, totals };
        },
      }),

      getMyCalendarEvents: tool({
        description:
          "Get the current user's own calendar events for a date range. Use when asked about your schedule, upcoming meetings, or events. The range must be at most 62 days.",
        inputSchema: z.object({
          from: z.string().describe("ISO date string start of range, e.g. 2026-07-15"),
          to: z.string().describe("ISO date string end of range, e.g. 2026-07-30"),
        }),
        execute: async ({ from, to }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "calendar:read");
          if (deny) return { denied: true, reason: deny };

          const start = new Date(from);
          const end = new Date(to);
          const diffMs = end.getTime() - start.getTime();
          const diffDays = diffMs / (1000 * 60 * 60 * 24);
          if (diffDays > 62) {
            return { error: "Date range too large. Please request at most 62 days at a time." };
          }

          const events = await this.calendar.getEvents(orgId, userId, start, end);
          const capped = events.slice(0, 100);

          return {
            count: capped.length,
            events: capped,
            truncated: events.length > 100,
          };
        },
      }),

      searchChatMessages: tool({
        description:
          "Search the user's chat messages across channels they are a member of. Only returns messages from channels the user belongs to.",
        inputSchema: z.object({
          query: z.string().min(1).describe("Text to search for in messages"),
          limit: z.number().int().min(1).max(10).default(10).describe("Maximum results to return (max 10)"),
        }),
        execute: async ({ query, limit }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "chat:messages:read");
          if (deny) return { denied: true, reason: deny };

          const safeLimit = Math.min(limit, 10);
          const result = await this.chatSearch.searchMessages(orgId, userId, query, safeLimit);
          return result;
        },
      }),
    };
  }
}
