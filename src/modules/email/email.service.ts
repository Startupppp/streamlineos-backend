import { Injectable } from "@nestjs/common";
import { appUrl } from "./app-url";
import { EmailSendersBase } from "./email-senders.base";
import { getTrialReminderEmail } from "./templates/platform";
import { EmailOutboxService } from "./email-outbox.service";
import { type EmailOptions } from "./email.provider";
import {
  getExpenseSubmittedEmailTemplate,
  getExpenseApprovedEmailTemplate,
  getExpenseRejectedEmailTemplate,
  getExpensePaidEmailTemplate,
  getProjectAssignmentEmailTemplate,
  getTicketAssignmentEmailTemplate,
  getTicketReviewRequestEmailTemplate,
  getTicketChangesRequestedEmailTemplate,
  getWeeklyAttendanceReportTemplate,
  getMonthlyExpenseReportTemplate,
  getTaskAssignedEmailTemplate,
  getDealStageChangeEmailTemplate,
  getLeadAssignedEmailTemplate,
  getAssetAssignedEmailTemplate,
  getTicketCreatedEmailTemplate,
  getTicketReplyEmailTemplate,
  getTicketStatusEmailTemplate,
  getTicketEscalationEmailTemplate,
  type TicketEscalationLevel,
  getHelpdeskTicketEmailTemplate,
  generateMonthlyExpenseReportXlsx,
  type MonthlyExpenseReportRow,
} from "./templates";

export type { EmailOptions, EmailAttachment } from "./email.provider";

@Injectable()
export class EmailService extends EmailSendersBase {
  constructor(private readonly outbox: EmailOutboxService) {
    super();
  }

  override sendEmail(options: EmailOptions): Promise<void> {
    return this.outbox.enqueueAndTry(options);
  }

  sendExpenseSubmittedEmail(
    approverEmail: string,
    approverName: string,
    employeeName: string,
    category: string,
    amount: string,
    description: string,
  ): Promise<void> {
    return this.sendEmail({
      to: approverEmail,
      subject: `New expense claim from ${employeeName}`,
      html: getExpenseSubmittedEmailTemplate(
        approverName,
        employeeName,
        category,
        amount,
        description,
        `${appUrl}/hr/expenses`,
      ),
    });
  }

  sendExpenseApprovedEmail(
    employeeEmail: string,
    employeeName: string,
    category: string,
    amount: string,
    approverName: string,
  ): Promise<void> {
    return this.sendEmail({
      to: employeeEmail,
      subject: "Your expense claim was approved",
      html: getExpenseApprovedEmailTemplate(employeeName, category, amount, approverName),
    });
  }

  sendExpenseRejectedEmail(
    employeeEmail: string,
    employeeName: string,
    category: string,
    amount: string,
    approverName: string,
    reason: string,
  ): Promise<void> {
    return this.sendEmail({
      to: employeeEmail,
      subject: "Your expense claim was rejected",
      html: getExpenseRejectedEmailTemplate(employeeName, category, amount, approverName, reason),
    });
  }

  sendExpensePaidEmail(
    employeeEmail: string,
    employeeName: string,
    category: string,
    amount: string,
    transactionRef?: string,
  ): Promise<void> {
    return this.sendEmail({
      to: employeeEmail,
      subject: "Your expense reimbursement was paid",
      html: getExpensePaidEmailTemplate(employeeName, category, amount, transactionRef),
    });
  }

  async sendWeeklyAttendanceReportEmail(
    weekRange: string,
    orgName: string,
    rows: { department: string; name: string; totalHours: string; autoCheckoutDays: number; overtimeDays: number; daysPresent: number }[],
    recipientEmails: string[],
  ): Promise<void> {
    if (recipientEmails.length === 0) return;
    const subject = `Attendance report — week of ${weekRange}`;
    const html = getWeeklyAttendanceReportTemplate(weekRange, orgName, rows);
    for (const email of recipientEmails) {
      await this.sendEmail({ to: email, subject, html });
    }
  }

  async sendMonthlyExpenseReportEmail(
    monthLabel: string,
    orgName: string,
    rows: MonthlyExpenseReportRow[],
    summary: { totalAmount: string; totalCount: number; pendingCount: number; approvedCount: number; paidCount: number; rejectedCount: number },
    recipientEmails: string[],
  ): Promise<void> {
    if (recipientEmails.length === 0) return;
    const subject = `Expense report — ${monthLabel}`;
    const html = getMonthlyExpenseReportTemplate(monthLabel, orgName, rows, summary);
    const xlsxBuffer = await generateMonthlyExpenseReportXlsx(monthLabel, orgName, rows, summary);
    const xlsxFilename = `Monthly-Expense-Report-${monthLabel.replace(/\s+/g, "-")}.xlsx`;
    for (const email of recipientEmails) {
      await this.sendEmail({
        to: email,
        subject,
        html,
        attachments: [
          {
            filename: xlsxFilename,
            content: xlsxBuffer,
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        ],
      });
    }
  }

  sendAssetAssignedEmail(
    email: string,
    employeeName: string,
    assetName: string,
    assetType: string,
    serialNumber: string | null,
  ): Promise<void> {
    return this.sendEmail({
      to: email,
      subject: `Asset assigned: ${assetName}`,
      html: getAssetAssignedEmailTemplate(employeeName, assetName, assetType, serialNumber),
    });
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
        `${appUrl}/projects/${projectId}`,
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
        `${appUrl}/projects/${projectId}?ticket=${ticketId}`,
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
        `${appUrl}/projects/${projectId}?ticket=${ticketId}`,
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
        `${appUrl}/projects/${projectId}?ticket=${ticketId}`,
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
