import { Injectable } from "@nestjs/common";
import { appUrl } from "./app-url";
import { type EmailOptions } from "./email.provider";
import { EmailService } from "./email.service";
import {
  getProjectAssignmentEmailTemplate,
  getTicketAssignmentEmailTemplate,
  getTicketReviewRequestEmailTemplate,
  getTicketChangesRequestedEmailTemplate,
  getTicketCreatedEmailTemplate,
  getTicketReplyEmailTemplate,
  getTicketStatusEmailTemplate,
  getTicketEscalationEmailTemplate,
  type TicketEscalationLevel,
  getHelpdeskTicketEmailTemplate,
  getTaskAssignedEmailTemplate,
  getDealStageChangeEmailTemplate,
  getLeadAssignedEmailTemplate,
  getTrialReminderEmail,
} from "./templates";

@Injectable()
export class EmailWorkNotificationsService {
  constructor(private readonly email: EmailService) {}

  private sendEmail(options: EmailOptions): Promise<void> {
    return this.email.sendEmail(options);
  }

  sendProjectAssignmentEmail(
    email: string,
    memberName: string,
    projectName: string,
    projectKey: string,
    projectId: number,
    assignedBy?: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `You've been added to ${projectName}`,
      html: getProjectAssignmentEmailTemplate(
        memberName,
        projectName,
        projectKey,
        `${appUrl()}/projects/${projectId}`,
        assignedBy,
      ),
    });
  }

  sendTicketAssignmentEmail(
    email: string,
    assigneeName: string,
    ticketTitle: string,
    ticketType: string,
    ticketPriority: string,
    projectName: string,
    projectId: number,
    ticketId: number,
    createdBy: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Ticket assigned: ${ticketTitle}`,
      html: getTicketAssignmentEmailTemplate(
        assigneeName,
        ticketTitle,
        ticketType,
        ticketPriority,
        projectName,
        `${appUrl()}/projects/${projectId}?ticket=${ticketId}`,
        createdBy,
      ),
    });
  }

  sendTicketReviewRequestEmail(
    email: string,
    reviewerName: string,
    ticketTitle: string,
    ticketType: string,
    projectName: string,
    projectId: number,
    ticketId: number,
    completedBy: string,
    comment?: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Ready for review: ${ticketTitle}`,
      html: getTicketReviewRequestEmailTemplate(
        reviewerName,
        ticketTitle,
        ticketType,
        projectName,
        `${appUrl()}/projects/${projectId}?ticket=${ticketId}`,
        completedBy,
        comment,
      ),
    });
  }

  sendTicketChangesRequestedEmail(
    email: string,
    assigneeName: string,
    ticketTitle: string,
    projectName: string,
    projectId: number,
    ticketId: number,
    reviewerName: string,
    comment?: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Changes requested: ${ticketTitle}`,
      html: getTicketChangesRequestedEmailTemplate(
        assigneeName,
        ticketTitle,
        projectName,
        `${appUrl()}/projects/${projectId}?ticket=${ticketId}`,
        reviewerName,
        comment,
      ),
    });
  }

  sendSupportTicketCreatedEmail(
    email: string,
    assigneeName: string,
    ticketTitle: string,
    priority: string,
    creatorName: string,
    ticketId: number,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `New support ticket: ${ticketTitle}`,
      html: getTicketCreatedEmailTemplate(assigneeName, ticketTitle, priority, creatorName, ticketId),
    });
  }

  sendSupportTicketReplyEmail(
    email: string,
    recipientName: string,
    ticketTitle: string,
    ticketId: number,
    authorName: string,
    messagePreview: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `New reply on ticket #${ticketId}`,
      html: getTicketReplyEmailTemplate(recipientName, ticketTitle, ticketId, authorName, messagePreview),
    });
  }

  sendSupportTicketStatusEmail(
    email: string,
    recipientName: string,
    ticketTitle: string,
    ticketId: number,
    newStatus: string,
    updatedBy: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Ticket #${ticketId} status: ${newStatus}`,
      html: getTicketStatusEmailTemplate(recipientName, ticketTitle, ticketId, newStatus, updatedBy),
    });
  }

  sendSupportTicketEscalationEmail(
    email: string,
    recipientName: string,
    ticketTitle: string,
    ticketId: number,
    escalationLevel: TicketEscalationLevel,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `SLA alert: ticket #${ticketId}`,
      html: getTicketEscalationEmailTemplate(recipientName, ticketTitle, ticketId, escalationLevel),
    });
  }

  sendTaskAssignedEmail(
    email: string,
    assigneeName: string,
    taskTitle: string,
    taskType: string,
    dueDate: string | null,
    creatorName: string,
    entityLabel?: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Task assigned: ${taskTitle}`,
      html: getTaskAssignedEmailTemplate(assigneeName, taskTitle, taskType, dueDate, creatorName, entityLabel),
    });
  }

  sendHelpdeskTicketEmail(
    email: string,
    recipientName: string,
    ticketTitle: string,
    category: string,
    priority: string,
    creatorName: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `New helpdesk ticket: ${ticketTitle}`,
      html: getHelpdeskTicketEmailTemplate(recipientName, ticketTitle, category, priority, creatorName),
    });
  }

  sendDealStageChangeEmail(
    email: string,
    recipientName: string,
    dealName: string,
    previousStage: string,
    newStage: string,
    dealValue: string | null,
    changedBy: string,
    dealId: number,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Deal stage updated: ${dealName}`,
      html: getDealStageChangeEmailTemplate(
        recipientName,
        dealName,
        previousStage,
        newStage,
        dealValue,
        changedBy,
        dealId,
      ),
    });
  }

  sendLeadAssignedEmail(
    email: string,
    repName: string,
    leadName: string,
    source: string,
    priority: string,
    assignedBy: string,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Lead assigned: ${leadName}`,
      html: getLeadAssignedEmailTemplate(repName, leadName, source, priority, assignedBy),
    });
  }

  sendTrialReminderEmail(email: string, orgName: string, daysLeft: number, upgradeUrl: string): Promise<void> {
    const { subject, html } = getTrialReminderEmail({ orgName, daysLeft, upgradeUrl });
    return this.sendEmail({ to: email, subject, html });
  }
}
