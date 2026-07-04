import { Injectable } from "@nestjs/common";
import { CreateNotificationInput, NotificationsService } from "../../notifications/notifications.service";

@Injectable()
export class PayrollNotificationsService {
  constructor(private readonly notifications: NotificationsService) {}

  async notifyPayslipPublished(
    orgId: string,
    userId: string,
    publicationId: number,
    month: string,
  ): Promise<void> {
    await this.notifications.create({
      orgId,
      userId,
      type: "SUCCESS",
      priority: "NORMAL",
      category: "HRMS",
      sourceModule: "payroll",
      title: "Payslip Published",
      message: `Your payslip for ${month} is ready to download.`,
      link: "/payroll/me/payslips",
      metadata: { publicationId },
    } satisfies CreateNotificationInput);
  }

  async notifyApprovalSubmitted(
    orgId: string,
    userId: string,
    runId: number,
  ): Promise<void> {
    await this.notifications.create({
      orgId,
      userId,
      type: "SUCCESS",
      priority: "NORMAL",
      category: "HRMS",
      sourceModule: "payroll",
      title: "Payroll Submitted for Approval",
      message: "Your payroll run has been submitted and is pending approval.",
      link: `/payroll/runs/${runId}`,
      metadata: { runId },
    } satisfies CreateNotificationInput);
  }

  async notifyApprovalPending(
    orgId: string,
    userId: string,
    runId: number,
    stage: string,
  ): Promise<void> {
    await this.notifications.create({
      orgId,
      userId,
      type: "INFO",
      priority: "HIGH",
      category: "HRMS",
      sourceModule: "payroll",
      title: "Payroll Approval Required",
      message: `Payroll run requires your approval at stage: ${stage}.`,
      link: `/payroll/runs/${runId}`,
      metadata: { runId, stage },
    } satisfies CreateNotificationInput);
  }

  async notifyExceptions(
    orgId: string,
    userId: string,
    runId: number,
    count: number,
  ): Promise<void> {
    await this.notifications.create({
      orgId,
      userId,
      type: "WARNING",
      priority: "HIGH",
      category: "HRMS",
      sourceModule: "payroll",
      title: "Payroll Exceptions Found",
      message: `${count} exception(s) require attention in the payroll run.`,
      link: `/payroll/runs/${runId}/exceptions`,
      metadata: { runId, count },
    } satisfies CreateNotificationInput);
  }

  async notifyDeclarationWindow(
    orgId: string,
    userId: string,
    financialYear: string,
    closesAt: Date,
  ): Promise<void> {
    await this.notifications.create({
      orgId,
      userId,
      type: "WARNING",
      priority: "NORMAL",
      category: "HRMS",
      sourceModule: "payroll",
      title: "Tax Declaration Deadline",
      message: `Submit your tax declarations for ${financialYear} before ${closesAt.toLocaleDateString()}.`,
      link: "/payroll/me/tax-declaration",
      metadata: { financialYear, closesAt: closesAt.toISOString() },
    } satisfies CreateNotificationInput);
  }

  async remindCalendarEvent(
    orgId: string,
    userId: string,
    eventId: number,
    eventTitle: string,
    eventDate: string,
  ): Promise<void> {
    await this.notifications.create({
      orgId,
      userId,
      type: "INFO",
      priority: "NORMAL",
      category: "HRMS",
      sourceModule: "payroll",
      title: "Payroll Calendar Reminder",
      message: `Upcoming payroll event: ${eventTitle} on ${eventDate}.`,
      link: "/payroll/calendar",
      metadata: { eventId, eventDate },
    } satisfies CreateNotificationInput);
  }
}
