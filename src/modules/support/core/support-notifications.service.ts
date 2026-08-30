import { Inject, Injectable } from "@nestjs/common";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { TicketEscalationLevel } from "../../email/templates";

@Injectable()
export class SupportNotificationsService {
  constructor(
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async sendAssignmentEmail(
    orgId: string,
    assigneeId: string,
    actorId: string,
    title: string,
    priority: string,
    ticketId: number,
    actorFallback: string,
  ): Promise<void> {
    await this.dispatch.emit({ eventKey: "support.ticket.assigned", orgId, actorUserId: actorId, targetUserIds: [assigneeId], entityType: "support_ticket", entityId: String(ticketId), title: "Support ticket assigned", message: `${title} (${priority})`, link: `/support/tickets/${ticketId}`, variables: { title, priority, actorName: actorFallback } });
  }

  async sendStatusEmail(
    orgId: string,
    creatorId: string,
    actorId: string,
    title: string,
    ticketId: number,
    status: string,
  ): Promise<void> {
    await this.dispatch.emit({ eventKey: "support.ticket.updated", orgId, actorUserId: actorId, targetUserIds: [creatorId], entityType: "support_ticket", entityId: String(ticketId), title: "Support ticket updated", message: `${title} is now ${status}.`, link: `/support/tickets/${ticketId}`, variables: { title, status } });
  }

  async sendReplyEmail(
    orgId: string,
    ticket: { title: string; createdBy: string; assigneeId: string | null },
    ticketId: number,
    authorId: string,
    body: string,
  ): Promise<void> {
    const notifyUserId = authorId === ticket.createdBy ? ticket.assigneeId : ticket.createdBy;
    if (!notifyUserId) return;

    await this.dispatch.emit({ eventKey: "support.ticket.customer_replied", orgId, actorUserId: authorId, targetUserIds: [notifyUserId], entityType: "support_ticket", entityId: String(ticketId), title: "New support ticket reply", message: body, link: `/support/tickets/${ticketId}`, variables: { title: ticket.title, body } });
  }

  async sendEscalationEmail(
    orgId: string,
    recipientId: string,
    ticketTitle: string,
    ticketId: number,
    escalationLevel: TicketEscalationLevel,
  ): Promise<void> {
    await this.dispatch.emit({ eventKey: "support.ticket.escalated", orgId, targetUserIds: [recipientId], entityType: "support_ticket", entityId: String(ticketId), title: "Support ticket escalation", message: `${ticketTitle} requires attention (${escalationLevel}).`, link: `/support/tickets/${ticketId}`, variables: { title: ticketTitle, escalationLevel } });
  }
}
