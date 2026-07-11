import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, ne } from "drizzle-orm";
import { organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { NotificationsService } from "../notifications/notifications.service";
import { AuditService } from "../../common/audit/audit.service";
import { logger } from "../../common/logger/logger.service";
import { HR_NOTIFY_ROLES, CEO_ROLES } from "./hr-role-constants";
import {
  resignationSubmittedTitle,
  resignationSubmittedMessage,
  resignationHrApprovedTitle,
  resignationHrApprovedMessage,
  resignationCeoApprovedMessage,
  resignationCeoRejectedMessage,
} from "./hr-notification-texts";

type ResignationNotificationType = "INFO" | "SUCCESS" | "WARNING" | "ERROR";

interface ResignationNotification {
  type: ResignationNotificationType;
  title: string;
  message: string;
}

const EXIT_LINK = "/hr/exit";

@Injectable()
export class ResignationJobsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  notifyResignationSubmitted(orgId: string, employeeId: string): void {
    this.run("resignation.submitted", async () => {
      const employeeName = await this.resolveEmployeeName(employeeId);
      const recipientIds = await this.findOrgUserIdsByRoles(orgId, [...HR_NOTIFY_ROLES], employeeId);
      await this.fanOut(orgId, recipientIds, {
        type: "INFO",
        title: resignationSubmittedTitle(),
        message: resignationSubmittedMessage(employeeName),
      });
      this.audit.log({
        action: "hr.resignation.submitted.notified",
        userId: employeeId,
        orgId,
        targetType: "resignation",
        metadata: { recipientCount: recipientIds.length },
      });
    });
  }

  notifyHrApproved(orgId: string, employeeId: string): void {
    this.run("resignation.hr_approved", async () => {
      const employeeName = await this.resolveEmployeeName(employeeId);
      const recipientIds = await this.findOrgUserIdsByRoles(orgId, [...CEO_ROLES], null);
      await this.fanOut(orgId, recipientIds, {
        type: "INFO",
        title: resignationHrApprovedTitle(),
        message: resignationHrApprovedMessage(employeeName),
      });
    });
  }

  notifyCeoDecision(orgId: string, employeeId: string, approved: boolean): void {
    this.run("resignation.ceo_decision", async () => {
      await this.fanOut(orgId, [employeeId], {
        type: approved ? "SUCCESS" : "WARNING",
        title: approved ? "Resignation Approved" : "Resignation Rejected",
        message: approved ? resignationCeoApprovedMessage() : resignationCeoRejectedMessage(),
      });
      this.audit.log({
        action: approved ? "hr.resignation.ceo_approved.notified" : "hr.resignation.ceo_rejected.notified",
        userId: employeeId,
        orgId,
        targetType: "resignation",
      });
    });
  }

  private async fanOut(
    orgId: string,
    recipientIds: string[],
    payload: ResignationNotification,
  ): Promise<void> {
    if (recipientIds.length === 0) return;
    await Promise.all(
      recipientIds.map((userId) =>
        this.notifications.create({
          orgId,
          userId,
          type: payload.type,
          title: payload.title,
          message: payload.message,
          link: EXIT_LINK,
        }),
      ),
    );
  }

  private async findOrgUserIdsByRoles(
    orgId: string,
    roles: string[],
    excludeUserId: string | null,
  ): Promise<string[]> {
    const conditions = [
      eq(organizationMembers.orgId, orgId),
      inArray(organizationMembers.role, roles),
    ];
    if (excludeUserId) conditions.push(ne(organizationMembers.userId, excludeUserId));
    const members = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(...conditions));
    return [...new Set(members.map((member) => member.userId))];
  }

  private async resolveEmployeeName(employeeId: string): Promise<string> {
    const employee = await this.db.query.users.findFirst({
      where: eq(users.id, employeeId),
      columns: { name: true },
    });
    return employee?.name ?? "Employee";
  }

  private run(job: string, task: () => Promise<void>): void {
    void task().catch((error: unknown) =>
      logger.error(`resignation-jobs:${job} failed`, { error }),
    );
  }
}
