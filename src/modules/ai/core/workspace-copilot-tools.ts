import { Injectable, Inject } from "@nestjs/common";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { organizationMembers, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CalendarService } from "../../calendar/calendar.service";
import { ChatSearchService } from "../../chat/chat-search.service";
import { ProjectsWorkQueryService } from "../../build/core/projects-work-query.service";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import {
  defineTool,
  data,
  denied,
  empty,
  failed,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "./registry/ask-os-tool.types";

@Injectable()
export class WorkspaceCopilotTools implements AskOsToolProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly calendar: CalendarService,
    private readonly chatSearch: ChatSearchService,
    private readonly workQuery: ProjectsWorkQueryService,
  ) {}

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "findPerson",
        description:
          "Resolve a person's name to org members matching that name. Returns up to 5 matches with id, name, email. Call this first before getPersonTicketStats when the user mentions someone by name.",
        input: z.object({
          name: z.string().min(1).describe("Full or partial name to search"),
        }),
        permission: "directory:people:view",
        run: async ({ name }, ctx) => {
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
                eq(organizationMembers.orgId, ctx.actor.orgId),
                eq(organizationMembers.status, "ACTIVE"),
                eq(users.isActive, true),
                isNull(users.deletedAt),
                sql`(
                  ${users.name} ILIKE ${q}
                  OR CONCAT(${users.firstName}, ' ', ${users.lastName}) ILIKE ${q}
                  OR ${users.email} ILIKE ${q}
                )`,
              ),
            )
            .limit(5);

          if (rows.length === 0) return empty("people", `No org member matches "${name}".`);

          return data({
            results: rows.map((r) => ({
              id: r.id,
              name: r.name ?? `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
              email: r.email ?? "",
            })),
            message: `Found ${rows.length} member(s).`,
          });
        },
      }),

      defineTool({
        key: "getPersonTicketStats",
        description:
          "Get ticket statistics for a specific org member. ALWAYS call findPerson first to get the userId from their name. Returns per-project totals (total, done, inProgress) plus cross-project summary.",
        input: z.object({
          userId: z.string().describe("The user ID obtained from findPerson"),
          projectId: z.number().int().positive().optional().describe("Filter to a specific project ID"),
        }),
        permission: "build:tickets:view",
        module: "build",
        run: async ({ userId: targetUserId, projectId }, ctx) => {
          if (ctx.scope !== "all" && targetUserId !== ctx.actor.userId)
            return denied("build:tickets:view");

          const result = await this.workQuery.getAllWork(ctx.caller, {
            limit: PAGE_SIZE_CAP,
            scope: "all",
            orderBy: "created",
            assigneeId: [targetUserId],
            projectIds: projectId !== undefined ? [projectId] : undefined,
            status: undefined,
            priority: undefined,
            type: undefined,
            labelIds: undefined,
            cycleId: undefined,
            excludeStatus: undefined,
          });

          const byProjectMap = new Map<
            number,
            { projectId: number; projectName: string; total: number; done: number; inProgress: number }
          >();
          for (const ticket of result.data) {
            const pid = ticket.projectId;
            const entry = byProjectMap.get(pid) ?? {
              projectId: pid,
              projectName: ticket.projectName,
              total: 0,
              done: 0,
              inProgress: 0,
            };
            entry.total++;
            if (ticket.status === "DONE") entry.done++;
            if (ticket.status === "IN_PROGRESS" || ticket.status === "IN_REVIEW") entry.inProgress++;
            byProjectMap.set(pid, entry);
          }

          const byProject = Array.from(byProjectMap.values()).sort((a, b) => b.total - a.total);
          const realTotal = result.total ?? result.data.length;
          const firstPageTotals = byProject.reduce(
            (acc, r) => ({
              total: acc.total + r.total,
              done: acc.done + r.done,
              inProgress: acc.inProgress + r.inProgress,
            }),
            { total: 0, done: 0, inProgress: 0 },
          );

          if (result.hasMore) {
            return data({
              byProject,
              totals: { ...firstPageTotals, total: realTotal },
              partial: true,
              note: `Showing first ${result.data.length} of ${realTotal} tickets; per-project breakdown and done/in-progress counts cover first page only.`,
            });
          }

          return data({ byProject, totals: { ...firstPageTotals, total: realTotal } });
        },
      }),

      defineTool({
        key: "getMyCalendarEvents",
        description:
          "Get the current user's own calendar events for a date range. Use when asked about your schedule, upcoming meetings, or events. The range must be at most 62 days.",
        input: z.object({
          from: z.string().describe("ISO date string start of range, e.g. 2026-07-15"),
          to: z.string().describe("ISO date string end of range, e.g. 2026-07-30"),
        }),
        permission: "calendar:read",
        module: "calendar",
        run: async ({ from, to }, ctx) => {
          const start = new Date(from);
          const end = new Date(to);
          const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
          if (diffDays > 62)
            return failed("Date range too large. Please request at most 62 days at a time.");

          const { events } = await this.calendar.getEvents(ctx.actor.orgId, ctx.actor.userId, start, end);
          const capped = events.slice(0, 100);

          if (capped.length === 0) return empty("calendar events");

          return data({
            count: capped.length,
            events: capped.map((event) => ({
              title: event.title,
              start: event.start.toISOString(),
              end: event.end.toISOString(),
              allDay: event.allDay ?? false,
              source: event.source,
              location: event.location ?? null,
              rsvp: event.myRsvpStatus ?? null,
            })),
            truncated: events.length > 100,
          });
        },
      }),

      defineTool({
        key: "searchChatMessages",
        description:
          "Search the user's chat messages across channels they are a member of. Only returns messages from channels the user belongs to.",
        input: z.object({
          query: z.string().min(1).describe("Text to search for in messages"),
          limit: z.number().int().min(1).max(10).default(10).describe("Maximum results to return (max 10)"),
        }),
        permission: "chat:messages:read",
        module: "chat",
        run: async ({ query, limit }, ctx) => {
          const safeLimit = Math.min(limit, 10);
          const result = await this.chatSearch.searchMessages(
            {
              orgId: ctx.actor.orgId,
              userId: ctx.actor.userId,
              membershipId: ctx.actor.membershipId,
              isOrgOwner: ctx.actor.isOrgOwner,
            },
            query,
            safeLimit,
          );

          if (result.results.length === 0) return empty("chat messages");

          return data({
            count: result.results.length,
            messages: result.results.map((row) => ({
              channelId: row.channelId,
              sender: row.sender?.name ?? null,
              content: row.content,
              createdAt: row.createdAt,
            })),
          });
        },
      }),
    ];
  }
}
