import { Injectable, Inject } from "@nestjs/common";
import { z } from "zod";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { CalendarService } from "../../../calendar/calendar.service";
import { ChatSearchService } from "../../../chat/chat-search.service";
import { ProjectsWorkQueryService } from "../../../build/core/projects-work-query.service";
import { resolvePeopleByName } from "../../../directory/person-seam";
import {
  defineTool,
  ambiguous,
  data,
  denied,
  empty,
  failed,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";

@AskOsTools()
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
          "Resolve a person's name or exact email address to a single active org member. Returns that member's id, name and email on a unique match, reports ambiguity when several members share the name, and returns empty when none match. Call this first before getPersonTicketStats when the user mentions someone by name.",
        input: z.object({
          name: z.string().min(1).describe("Full or partial name to search"),
        }),
        permission: "directory:people:view",
        run: async ({ name }, ctx) => {
          const needle = name.trim();
          const resolutions = await resolvePeopleByName(this.db, ctx.actor.orgId, [needle]);
          const resolution = resolutions.get(needle);

          if (!resolution || resolution.status === "unresolved")
            return empty("people", `No org member matches "${name}".`);

          if (resolution.status === "ambiguous") {
            return ambiguous(
              `"${name}" matches ${resolution.candidates.length} members. Which did you mean?`,
              [...resolution.candidates],
            );
          }

          const resolvedName = resolution.displayName ?? needle;
          return data({
            results: [
              {
                id: resolution.userId,
                name: resolvedName,
                ...(resolution.email !== undefined ? { email: resolution.email } : {}),
              },
            ],
            message: `Found ${resolvedName}.`,
          });
        },
      }),

      defineTool({
        key: "getPersonTicketStats",
        description:
          "Get ticket statistics for a specific org member. ALWAYS call findPerson first to get the userId from their name. Returns per-project totals (total, done, inProgress) plus cross-project summary. Counts are exact and not capped.",
        input: z.object({
          userId: z.string().describe("The user ID obtained from findPerson"),
          projectId: z.number().int().positive().optional().describe("Filter to a specific project ID"),
        }),
        permission: "build:tickets:view",
        module: "build",
        run: async ({ userId: targetUserId, projectId }, ctx) => {
          if (!ctx.read.unrestricted && targetUserId !== ctx.actor.userId)
            return denied("build:tickets:view");

          const { byProject, totals } = await this.workQuery.countTicketsByProjectAndStatus(ctx.caller, {
            assigneeId: targetUserId,
            projectIds: projectId !== undefined ? [projectId] : undefined,
          });

          if (totals.total === 0) return empty("tickets", "No tickets assigned to this person.");

          return data({ byProject, totals });
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
