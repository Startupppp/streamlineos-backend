import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { eq, ilike, isNull } from "drizzle-orm";
import { DB_ENUMS } from "../../../../db/enums.generated";
import { tickets } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import { ticketScope } from "../../../build/core/tickets-scope";
import {
  type AskOsToolDefinition,
  type AskOsToolProvider,
  defineTool,
  data,
  empty,
  needsConfirmation,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";

@AskOsTools()
@Injectable()
export class ProjectsCopilotTools implements AskOsToolProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly confirmation: AiConfirmationService,
  ) {}

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "readTicket",
        description:
          "Read a specific ticket by its numeric ID. Returns ticket details if found within the org.",
        input: z.object({
          ticketId: z.number().int().positive().describe("Numeric ticket ID"),
        }),
        permission: "build:tickets:view",
        module: "build",
        run: async ({ ticketId }, ctx) => {
          const { orgId, userId } = ctx.actor;
          const rows = await ctx.read.read(
            {
              tenant: tickets.orgId,
              scope: ticketScope(orgId, userId),
              and: [eq(tickets.id, ticketId), isNull(tickets.deletedAt)],
            },
            ({ sql: where }) =>
              this.db
                .select({
                  id: tickets.id,
                  title: tickets.title,
                  status: tickets.status,
                  priority: tickets.priority,
                  type: tickets.type,
                  description: tickets.description,
                  assigneeMembershipId: tickets.assigneeMembershipId,
                  projectId: tickets.projectId,
                  createdAt: tickets.createdAt,
                })
                .from(tickets)
                .where(where)
                .limit(1),
            () => [],
          );
          const ticket = rows[0];
          if (!ticket) return empty("ticket", "Ticket not found in this org.");
          return data({ found: true, ticket });
        },
      }),

      defineTool({
        key: "searchTickets",
        description:
          "Search tickets by title within the org. Optionally filter by projectId or status.",
        input: z.object({
          query: z.string().min(1).describe("Search query for ticket title"),
          projectId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Filter by project ID"),
          status: z
            .string()
            .optional()
            .describe("Filter by status (e.g. OPEN, IN_PROGRESS, DONE)"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(10)
            .default(5)
            .describe("Max results to return"),
        }),
        permission: "build:tickets:view",
        module: "build",
        run: async ({ query, projectId, status, limit }, ctx) => {
          const { orgId, userId } = ctx.actor;
          const results = await ctx.read.read(
            {
              tenant: tickets.orgId,
              scope: ticketScope(orgId, userId),
              and: [
                ilike(tickets.title, `%${query}%`),
                isNull(tickets.deletedAt),
                projectId !== undefined
                  ? eq(tickets.projectId, projectId)
                  : undefined,
                status !== undefined ? eq(tickets.status, status) : undefined,
              ],
            },
            ({ sql: where }) =>
              this.db
                .select({
                  id: tickets.id,
                  title: tickets.title,
                  status: tickets.status,
                  priority: tickets.priority,
                  type: tickets.type,
                  projectId: tickets.projectId,
                })
                .from(tickets)
                .where(where)
                .limit(limit),
            () => [],
          );
          return data({
            results,
            returned: results.length,
            truncated: results.length === limit,
          });
        },
      }),

      defineTool({
        key: "createTicket",
        description: "Create a new ticket in a project.",
        input: z.object({
          projectId: z
            .number()
            .int()
            .positive()
            .describe("Project ID to create the ticket in"),
          title: z.string().min(1).max(300).describe("Ticket title"),
          description: z.string().optional().describe("Ticket description"),
          type: z
            .enum(DB_ENUMS.ticket_type)
            .default("TASK")
            .describe("Ticket type"),
          priority: z
            .enum(["LOW", "MEDIUM", "HIGH", "URGENT"])
            .default("MEDIUM")
            .describe("Ticket priority"),
          assigneeId: z
            .string()
            .optional()
            .describe("User ID to assign the ticket to"),
        }),
        confirms: "ticket.create",
        module: "build",
        run: async (
          { projectId, title, description, type, priority, assigneeId },
          ctx,
        ) => {
          const { orgId, userId } = ctx.actor;
          const payload: Record<string, unknown> = {
            projectId,
            title,
            type,
            priority,
          };
          if (description !== undefined) payload.description = description;
          if (assigneeId !== undefined) payload.assigneeId = assigneeId;

          const { proposalId, token, expiresAt } =
            await this.confirmation.propose({
              orgId,
              userId,
              action: "ticket.create",
              payload,
            });

          return needsConfirmation({
            proposalId,
            token,
            expiresAt,
            action: "ticket.create",
            summary: `Create ticket: ${title}`,
            preview: { projectId, title, type, priority, assigneeId },
          });
        },
      }),

      defineTool({
        key: "updateTicketStatus",
        description: "Update a ticket's status.",
        input: z.object({
          ticketId: z.number().int().positive().describe("Numeric ticket ID"),
          status: z.string().min(1).describe("New status value"),
          reason: z
            .string()
            .optional()
            .describe("Reason for the status change"),
        }),
        confirms: "ticket.updateStatus",
        module: "build",
        run: async ({ ticketId, status, reason }, ctx) => {
          const { orgId, userId } = ctx.actor;
          const existing = await ctx.read.read(
            {
              tenant: tickets.orgId,
              scope: ticketScope(orgId, userId),
              and: [eq(tickets.id, ticketId), isNull(tickets.deletedAt)],
            },
            ({ sql: where }) =>
              this.db
                .select({ id: tickets.id, title: tickets.title })
                .from(tickets)
                .where(where)
                .limit(1),
            () => [],
          );

          if (!existing[0])
            return empty("ticket", "Ticket not found in this org.");

          const payload: Record<string, unknown> = {
            ticketId,
            status,
            title: existing[0].title,
          };
          if (reason !== undefined) payload.reason = reason;

          const { proposalId, token, expiresAt } =
            await this.confirmation.propose({
              orgId,
              userId,
              action: "ticket.updateStatus",
              payload,
            });

          return needsConfirmation({
            proposalId,
            token,
            expiresAt,
            action: "ticket.updateStatus",
            summary: `Update ticket #${ticketId} status to ${status}`,
            preview: {
              ticketId,
              title: existing[0].title,
              newStatus: status,
              reason,
            },
          });
        },
      }),

      defineTool({
        key: "addTicketComment",
        description: "Add a comment to a ticket.",
        input: z.object({
          ticketId: z.number().int().positive().describe("Numeric ticket ID"),
          comment: z.string().min(1).max(5000).describe("Comment text to add"),
        }),
        confirms: "ticket.addComment",
        module: "build",
        run: async ({ ticketId, comment }, ctx) => {
          const { orgId, userId } = ctx.actor;
          const existing = await ctx.read.read(
            {
              tenant: tickets.orgId,
              scope: ticketScope(orgId, userId),
              and: [eq(tickets.id, ticketId), isNull(tickets.deletedAt)],
            },
            ({ sql: where }) =>
              this.db
                .select({ id: tickets.id, title: tickets.title })
                .from(tickets)
                .where(where)
                .limit(1),
            () => [],
          );

          if (!existing[0])
            return empty("ticket", "Ticket not found in this org.");

          const { proposalId, token, expiresAt } =
            await this.confirmation.propose({
              orgId,
              userId,
              action: "ticket.addComment",
              payload: { ticketId, comment },
            });

          return needsConfirmation({
            proposalId,
            token,
            expiresAt,
            action: "ticket.addComment",
            summary: `Add comment to ticket #${ticketId}`,
            preview: { ticketId, title: existing[0].title, comment },
          });
        },
      }),

      defineTool({
        key: "createCalendarReminder",
        description: "Create a calendar reminder event.",
        input: z.object({
          title: z.string().min(1).max(200).describe("Reminder title"),
          startDate: z.string().describe("ISO 8601 start datetime"),
          endDate: z.string().describe("ISO 8601 end datetime"),
          description: z
            .string()
            .optional()
            .describe("Reminder description or notes"),
          fromTicketId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Optional ticket ID this reminder is linked to"),
        }),
        confirms: "calendar.createReminder",
        module: "calendar",
        run: async (
          { title, startDate, endDate, description, fromTicketId },
          ctx,
        ) => {
          const { orgId, userId, timezone } = ctx.actor;
          const payload: Record<string, unknown> = {
            title,
            startDate,
            endDate,
            timezone,
          };
          if (description !== undefined) payload.description = description;
          if (fromTicketId !== undefined) payload.fromTicketId = fromTicketId;

          const { proposalId, token, expiresAt } =
            await this.confirmation.propose({
              orgId,
              userId,
              action: "calendar.createReminder",
              payload,
            });

          return needsConfirmation({
            proposalId,
            token,
            expiresAt,
            action: "calendar.createReminder",
            summary: `Create reminder: ${title}`,
            preview: {
              title,
              startDate,
              endDate,
              description,
              fromTicketId,
              timezone,
            },
          });
        },
      }),
    ];
  }
}
