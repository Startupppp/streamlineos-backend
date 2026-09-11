import { Inject, Injectable } from "@nestjs/common";
import { inArray } from "drizzle-orm";
import { logger } from "../../../../common/logger/logger.service";
import {
  registerAfterCommit,
} from "../../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { users } from "../../../../db/schema";
import { AccessService } from "../../../access/access.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { HrAutomationEngineService } from "../../automations/hr-automation-engine.service";
import { EmploymentFactsService } from "../../../directory/employment-facts.service";

export type OnboardingInitiationRecipient = {
  id: string;
  email: string | null;
  name: string | null;
  designation: string | null;
  joiningDate: string | null;
};

@Injectable()
export class OnboardingInitiationDispatchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationDispatchService,
    private readonly access: AccessService,
    private readonly automation: HrAutomationEngineService,
    private readonly employment: EmploymentFactsService,
  ) {}

  schedule(
    orgId: string,
    target: OnboardingInitiationRecipient,
    taskCount: number,
    ownerRoleCounts: ReadonlyMap<string, number>,
  ): void {
    const dispatch = () =>
      runInNewTenantTransaction(this.db, orgId, () =>
        this.dispatch(orgId, target, taskCount, ownerRoleCounts),
      ).catch((error: unknown) => {
        logger.error("onboarding initiation dispatch failed", {
          orgId,
          employeeUserId: target.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });
    if (!registerAfterCommit(dispatch)) void dispatch();
  }

  private async dispatch(
    orgId: string,
    target: OnboardingInitiationRecipient,
    taskCount: number,
    ownerRoleCounts: ReadonlyMap<string, number>,
  ): Promise<void> {
    const deliveries: Array<Promise<unknown>> = [];
    deliveries.push(this.notifications.emit({
      eventKey: "hr.onboarding.started",
      orgId,
      targetUserIds: [target.id],
      entityType: "employee",
      entityId: target.id,
      message: "Your onboarding has started.",
      variables: { employeeName: target.name ?? "there", designation: target.designation ?? "Employee", joiningDate: this.joiningDateLabel(target.joiningDate), taskCount },
    }));

    const hrTaskCount = ownerRoleCounts.get("HR") ?? 0;
    if (hrTaskCount > 0) {
      const holders = await this.access.membersWithPermission(orgId, "hr:onboarding:manage");
      const userIds = [...new Set(holders.map((holder) => holder.userId))].filter(
        (userId) => userId !== target.id,
      );
      if (userIds.length > 0) {
        const recipients = await this.db
          .select({ id: users.id, email: users.email, name: users.name })
          .from(users)
          .where(inArray(users.id, userIds))
          .limit(Math.max(userIds.length, 1));
        deliveries.push(this.notifications.emit({
          eventKey: "hr.onboarding.started",
          orgId,
          targetUserIds: recipients.map((r) => r.id),
          entityType: "employee",
          entityId: target.id,
          message: `${target.name ?? "A new joiner"} has onboarding tasks assigned to HR.`,
          variables: { employeeName: target.name ?? "the new joiner", ownerRole: "HR", taskCount: hrTaskCount },
        }));
      }
    }

    const managerTaskCount = ownerRoleCounts.get("MANAGER") ?? 0;
    if (managerTaskCount > 0) {
      const facts = await this.employment.getFacts(orgId, target.id);
      if (facts.managerUserId) {
        deliveries.push(this.notifications.emit({
          eventKey: "hr.onboarding.started",
          orgId,
          targetUserIds: [facts.managerUserId],
          entityType: "employee",
          entityId: target.id,
          message: `${target.name ?? "A new joiner"} has onboarding tasks assigned to you.`,
          variables: { employeeName: target.name ?? "the new joiner", ownerRole: "Manager", taskCount: managerTaskCount },
        }));
      }
    }

    await Promise.all(deliveries);
    await this.automation.emit(orgId, "employee.created", {
      userId: target.id,
      employeeName: target.name ?? "",
      employeeEmail: target.email ?? "",
      createdAt: new Date().toISOString(),
    });
  }

  private joiningDateLabel(joiningDate: string | null): string {
    const date = joiningDate ? new Date(`${joiningDate}T00:00:00`) : new Date();
    return date.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
}
