import { Inject, Injectable } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { tool } from "ai";
import { z } from "zod";
import { and, eq, ilike } from "drizzle-orm";
import { tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { ToolAccessService } from "./tool-access.service";
import { AiConfirmationService } from "../confirmation/ai-confirmation.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

export interface ProjectsCopilotContext {
  actor: CurrentUserContext;
}

@Injectable()
export class ProjectsCopilotTools {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly toolAccess: ToolAccessService,
    private readonly confirmation: AiConfirmationService,
    private readonly moduleRef: ModuleRef,
  ) {}

  buildTools(ctx: ProjectsCopilotContext) {
    const { orgId, userId } = ctx.actor;

    return {
      readTicket: tool({
        description: "Read a specific ticket by its numeric ID. Returns ticket details if found within the org.",
        inputSchema: z.object({
          ticketId: z.number().int().positive().describe("Numeric ticket ID"),
        }),
        execute: async ({ ticketId }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "build:tickets:view");
          if (deny) return { denied: true, reason: deny };

          const rows = await this.db
            .select({
              id: tickets.id,
              title: tickets.title,
              status: tickets.status,
              priority: tickets.priority,
              type: tickets.type,
              description: tickets.description,
              assigneeId: tickets.assigneeId,
              projectId: tickets.projectId,
              createdAt: tickets.createdAt,
            })
            .from(tickets)
            .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)))
            .limit(1);

          const ticket = rows[0];
          if (!ticket) return { found: false };
          return { found: true, ticket };
        },
      }),

      searchTickets: tool({
        description: "Search tickets by title within the org. Optionally filter by projectId or status.",
        inputSchema: z.object({
          query: z.string().min(1).describe("Search query for ticket title"),
          projectId: z.number().int().positive().optional().describe("Filter by project ID"),
          status: z.string().optional().describe("Filter by status (e.g. OPEN, IN_PROGRESS, DONE)"),
          limit: z.number().int().min(1).max(10).default(5).describe("Max results to return"),
        }),
        execute: async ({ query, projectId, status, limit }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "build:tickets:view");
          if (deny) return { denied: true, reason: deny };

          const conditions = [eq(tickets.orgId, orgId), ilike(tickets.title, `%${query}%`)];
          if (projectId !== undefined) conditions.push(eq(tickets.projectId, projectId));
          if (status !== undefined) conditions.push(eq(tickets.status, status));

          const results = await this.db
            .select({
              id: tickets.id,
              title: tickets.title,
              status: tickets.status,
              priority: tickets.priority,
              type: tickets.type,
              projectId: tickets.projectId,
            })
            .from(tickets)
            .where(and(...conditions))
            .limit(limit);

          return { results, total: results.length };
        },
      }),

      createTicket: tool({
        description: "Create a new ticket in a project. Returns a confirmation card — the user must confirm before the ticket is created.",
        inputSchema: z.object({
          projectId: z.number().int().positive().describe("Project ID to create the ticket in"),
          title: z.string().min(1).max(300).describe("Ticket title"),
          description: z.string().optional().describe("Ticket description"),
          type: z.enum(["TASK", "STORY", "BUG", "EPIC", "SUBTASK"]).default("TASK").describe("Ticket type"),
          priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM").describe("Ticket priority"),
          assigneeId: z.string().optional().describe("User ID to assign the ticket to"),
        }),
        execute: async ({ projectId, title, description, type, priority, assigneeId }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "build:tickets:create");
          if (deny) return { denied: true, reason: deny };

          const payload: Record<string, unknown> = { projectId, title, type, priority };
          if (description !== undefined) payload.description = description;
          if (assigneeId !== undefined) payload.assigneeId = assigneeId;

          const { proposalId, token, expiresAt } = await this.confirmation.propose({
            orgId,
            userId,
            action: "ticket.create",
            payload,
          });

          return {
            requiresConfirmation: true,
            proposalId,
            token,
            expiresAt,
            action: "ticket.create",
            summary: `Create ticket: ${title}`,
            preview: { projectId, title, type, priority, assigneeId },
          };
        },
      }),

      updateTicketStatus: tool({
        description: "Update a ticket's status. Returns a confirmation card — the user must confirm before the status is changed.",
        inputSchema: z.object({
          ticketId: z.number().int().positive().describe("Numeric ticket ID"),
          status: z.string().min(1).describe("New status value"),
          reason: z.string().optional().describe("Reason for the status change"),
        }),
        execute: async ({ ticketId, status, reason }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "build:tickets:update");
          if (deny) return { denied: true, reason: deny };

          const existing = await this.db
            .select({ id: tickets.id, title: tickets.title })
            .from(tickets)
            .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)))
            .limit(1);

          if (!existing[0]) return { denied: false, found: false, message: "Ticket not found in this org." };

          const payload: Record<string, unknown> = { ticketId, status, title: existing[0].title };
          if (reason !== undefined) payload.reason = reason;

          const { proposalId, token, expiresAt } = await this.confirmation.propose({
            orgId,
            userId,
            action: "ticket.updateStatus",
            payload,
          });

          return {
            requiresConfirmation: true,
            proposalId,
            token,
            expiresAt,
            action: "ticket.updateStatus",
            summary: `Update ticket #${ticketId} status to ${status}`,
            preview: { ticketId, title: existing[0].title, newStatus: status, reason },
          };
        },
      }),

      addTicketComment: tool({
        description: "Add a comment to a ticket. Returns a confirmation card — the user must confirm before the comment is posted.",
        inputSchema: z.object({
          ticketId: z.number().int().positive().describe("Numeric ticket ID"),
          comment: z.string().min(1).max(5000).describe("Comment text to add"),
        }),
        execute: async ({ ticketId, comment }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "build:tickets:update");
          if (deny) return { denied: true, reason: deny };

          const existing = await this.db
            .select({ id: tickets.id, title: tickets.title })
            .from(tickets)
            .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)))
            .limit(1);

          if (!existing[0]) return { denied: false, found: false, message: "Ticket not found in this org." };

          const { proposalId, token, expiresAt } = await this.confirmation.propose({
            orgId,
            userId,
            action: "ticket.addComment",
            payload: { ticketId, comment, title: existing[0].title },
          });

          return {
            requiresConfirmation: true,
            proposalId,
            token,
            expiresAt,
            action: "ticket.addComment",
            summary: `Add comment to ticket #${ticketId}`,
            preview: { ticketId, title: existing[0].title, comment },
          };
        },
      }),

      createCalendarReminder: tool({
        description: "Create a calendar reminder event. Returns a confirmation card — the user must confirm before the event is created.",
        inputSchema: z.object({
          title: z.string().min(1).max(200).describe("Reminder title"),
          startDate: z.string().describe("ISO 8601 start datetime"),
          endDate: z.string().describe("ISO 8601 end datetime"),
          description: z.string().optional().describe("Reminder description or notes"),
          fromTicketId: z.number().int().positive().optional().describe("Optional ticket ID this reminder is linked to"),
        }),
        execute: async ({ title, startDate, endDate, description, fromTicketId }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "calendar:write");
          if (deny) return { denied: true, reason: deny };

          const payload: Record<string, unknown> = { title, startDate, endDate };
          if (description !== undefined) payload.description = description;
          if (fromTicketId !== undefined) payload.fromTicketId = fromTicketId;

          const { proposalId, token, expiresAt } = await this.confirmation.propose({
            orgId,
            userId,
            action: "calendar.createReminder",
            payload,
          });

          return {
            requiresConfirmation: true,
            proposalId,
            token,
            expiresAt,
            action: "calendar.createReminder",
            summary: `Create reminder: ${title}`,
            preview: { title, startDate, endDate, description, fromTicketId },
          };
        },
      }),
    };
  }
}
