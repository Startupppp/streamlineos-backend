import { Injectable } from "@nestjs/common";
import { appUrl } from "./app-url";
import { EmailSendersBase, invitationEmailOptions, welcomeEmailOptions } from "./email-senders.base";
import { EmailProviderService } from "./email.provider";
import { EmailOutboxService, type EmailQueueOutcome } from "./email-outbox.service";
import { type EmailOptions } from "./email.provider";
import {
  getMembershipAddedEmailTemplate,
  getExpenseSubmittedEmailTemplate,
  getExpenseApprovedEmailTemplate,
  getExpenseRejectedEmailTemplate,
  getExpensePaidEmailTemplate,
  getAttendanceReportTemplate,
  getMonthlyExpenseReportTemplate,
  getAssetAssignedEmailTemplate,
  generateMonthlyExpenseReportXlsx,
  type MonthlyExpenseReportRow,
} from "./templates";

export type { EmailOptions } from "./email.provider";

@Injectable()
export class EmailService extends EmailSendersBase {
  constructor(
    private readonly outbox: EmailOutboxService,
    emailProvider: EmailProviderService,
  ) {
    super(emailProvider);
  }

  override sendEmail(options: EmailOptions): Promise<void> {
    return this.outbox.enqueueAndTry(options);
  }

  async queueInvitationEmail(
    email: string,
    token: string,
    organizationName: string,
  ): Promise<void> {
    await this.outbox.enqueueOnly(
      invitationEmailOptions(email, token, organizationName),
    );
  }

  queueWelcomeEmail(input: {
    organizationId: string;
    recipientUserId: string;
    email: string;
    name: string;
    setupUrl: string;
  }): Promise<EmailQueueOutcome> {
    return this.outbox.enqueueOnly({
      ...welcomeEmailOptions(input.email, input.name, input.setupUrl),
      organizationId: input.organizationId,
      recipientUserId: input.recipientUserId,
    });
  }

  queueMembershipAddedEmail(input: {
    organizationId: string;
    recipientUserId: string;
    email: string;
    name: string;
    organizationName: string;
    signInUrl: string;
  }): Promise<EmailQueueOutcome> {
    return this.outbox.enqueueOnly({
      to: input.email,
      subject: `You've been added to ${input.organizationName}`,
      html: getMembershipAddedEmailTemplate(input.name, input.organizationName, input.signInUrl),
      organizationId: input.organizationId,
      recipientUserId: input.recipientUserId,
    });
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
        `${appUrl()}/hr/expenses`,
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
      html: getExpenseApprovedEmailTemplate(
        employeeName,
        category,
        amount,
        approverName,
      ),
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
      html: getExpenseRejectedEmailTemplate(
        employeeName,
        category,
        amount,
        approverName,
        reason,
      ),
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
      html: getExpensePaidEmailTemplate(
        employeeName,
        category,
        amount,
        transactionRef,
      ),
    });
  }

  async queueAttendanceReportEmail(
    dateRange: string,
    orgName: string,
    rows: {
      department: string;
      name: string;
      totalHours: string;
      autoCheckoutDays: number;
      overtimeDays: number;
      daysPresent: number;
    }[],
    recipients: ReadonlyArray<{ email: string; userId: string }>,
    organizationId: string,
  ): Promise<number> {
    if (recipients.length === 0) return 0;
    const subject = `Attendance report — ${dateRange}`;
    const html = getAttendanceReportTemplate(dateRange, orgName, rows);
    return this.outbox.enqueueForDelivery(
      recipients.map((recipient) => ({
        to: recipient.email,
        subject,
        html,
        organizationId,
        recipientUserId: recipient.userId,
      })),
    );
  }

  async sendMonthlyExpenseReportEmail(
    monthLabel: string,
    orgName: string,
    rows: MonthlyExpenseReportRow[],
    summary: {
      totalAmount: string;
      totalCount: number;
      pendingCount: number;
      approvedCount: number;
      paidCount: number;
      rejectedCount: number;
    },
    recipientEmails: string[],
  ): Promise<void> {
    if (recipientEmails.length === 0) return;
    const subject = `Expense report — ${monthLabel}`;
    const html = getMonthlyExpenseReportTemplate(
      monthLabel,
      orgName,
      rows,
      summary,
    );
    const xlsxBuffer = await generateMonthlyExpenseReportXlsx(
      monthLabel,
      orgName,
      rows,
      summary,
    );
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
      html: getAssetAssignedEmailTemplate(
        employeeName,
        assetName,
        assetType,
        serialNumber,
      ),
    });
  }
}
