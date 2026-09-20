import { ProjectsTicketsService } from "../../../build/core/projects-tickets.service";
import { ProjectsTicketCommentsService } from "../../../build/core/projects-ticket-comments.service";
import {
  ticketAssignPayloadSchema,
  ticketCommentPayloadSchema,
  ticketCreatePayloadSchema,
  ticketSprintPayloadSchema,
  ticketStatusUpdatePayloadSchema,
} from "../dto/confirm-action-payloads.schemas";
import { defineConfirmableAction } from "./confirmable-action.types";

export const BUILD_CONFIRM_ACTIONS = [
  defineConfirmableAction({
    action: "ticket.create",
    permission: "build:tickets:create",
    payload: ticketCreatePayloadSchema,
    resolve: (moduleRef) => moduleRef.get(ProjectsTicketsService, { strict: false }),
    execute: async (payload, { actor }, tickets) => {
      const ticket = await tickets.createTicket(actor, payload.projectId, {
        title: payload.title,
        type: payload.type,
        priority: payload.priority,
        ...(payload.description !== undefined && { description: payload.description }),
        ...(payload.assigneeId !== undefined && { assigneeId: payload.assigneeId }),
      });
      return {
        result: { ticketId: ticket.id, title: ticket.title },
        summary: `Ticket created: ${ticket.title}`,
      };
    },
  }),

  defineConfirmableAction({
    action: "ticket.updateStatus",
    permission: "build:tickets:update",
    payload: ticketStatusUpdatePayloadSchema,
    resolve: (moduleRef) => ({
      tickets: moduleRef.get(ProjectsTicketsService, { strict: false }),
      comments: moduleRef.get(ProjectsTicketCommentsService, { strict: false }),
    }),
    execute: async ({ ticketId, status, title, reason }, { actor }, { tickets, comments }) => {
      await tickets.updateTicket(actor, ticketId, { status });
      if (reason !== undefined && reason.trim().length > 0) {
        await comments.addComment(actor, ticketId, { content: reason });
      }
      const subject = title === undefined ? `Ticket #${ticketId}` : `Ticket #${ticketId} "${title}"`;
      return {
        result: { ticketId, status, title, reason },
        summary: `${subject} status updated to ${status}`,
      };
    },
  }),

  defineConfirmableAction({
    action: "ticket.addComment",
    permission: "build:tickets:update",
    payload: ticketCommentPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(ProjectsTicketCommentsService, { strict: false }),
    execute: async ({ ticketId, comment }, { actor }, comments) => {
      const created = await comments.addComment(actor, ticketId, { content: comment });
      return {
        result: { commentId: created.id },
        summary: `Comment added to ticket #${ticketId}`,
      };
    },
  }),

  defineConfirmableAction({
    action: "ticket.assign",
    permission: "build:tickets:update",
    payload: ticketAssignPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(ProjectsTicketsService, { strict: false }),
    execute: async ({ ticketId, assigneeId, assigneeName }, { actor }, tickets) => {
      await tickets.updateTicket(actor, ticketId, { assigneeId });
      return {
        result: { ticketId, assigneeId },
        summary: `Ticket #${ticketId} assigned to ${assigneeName ?? assigneeId}`,
      };
    },
  }),

  defineConfirmableAction({
    action: "ticket.moveToSprint",
    permission: "build:tickets:update",
    payload: ticketSprintPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(ProjectsTicketsService, { strict: false }),
    execute: async ({ ticketId, sprintId, sprintName }, { actor }, tickets) => {
      await tickets.updateTicket(actor, ticketId, { sprintId });
      return {
        result: { ticketId, sprintId },
        summary: `Ticket #${ticketId} moved to sprint "${sprintName ?? sprintId}"`,
      };
    },
  }),
] as const;
