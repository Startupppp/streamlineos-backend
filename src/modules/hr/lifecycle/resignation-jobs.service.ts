import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { organizationMembers, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { NotificationsService } from "../../notifications/notifications.service";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import { logger } from "../../../common/logger/logger.service";
import {
  resignationSubmittedTitle,
  resignationSubmittedMessage,
  resignationHrApprovedTitle,
  resignationHrApprovedMessage,
  resignationFinalApprovedMessage,
  resignationFinalRejectedMessage,
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
    private readonly access: AccessService,
  ) {}

  notifyResignationSubmitted(orgId: string, employeeId: string): void {
    this.run("resignation.submitted", async () => {
      const employeeName = await this.resolveEmployeeName(employeeId);
      const holders = await this.access.membersWithPermission(orgId, "hr:exit:manage");
      const recipientIds = [...new Set(
        holders.filter((m) => m.userId !== employeeId).map((m) => m.userId),
      )];
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
      const orgAdminRows = await this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.isOwner, true),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .limit(10_000);
      const recipientIds = orgAdminRows.map((m) => m.userId);
      await this.fanOut(orgId, recipientIds, {
        type: "INFO",
        title: resignationHrApprovedTitle(),
        message: resignationHrApprovedMessage(employeeName),
      });
    });
  }

  notifyFinalDecision(orgId: string, employeeId: string, approved: boolean): void {
    this.run("resignation.final_decision", async () => {
      await this.fanOut(orgId, [employeeId], {
        type: approved ? "SUCCESS" : "WARNING",
        title: approved ? "Resignation Approved" : "Resignation Rejected",
        message: approved ? resignationFinalApprovedMessage() : resignationFinalRejectedMessage(),
      });
      this.audit.log({
        action: approved ? "hr.resignation.final_approved.notified" : "hr.resignation.final_rejected.notified",
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
