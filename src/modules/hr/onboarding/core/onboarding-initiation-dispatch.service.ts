import { Inject, Injectable } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { logger } from "../../../../common/logger/logger.service";
import {
  registerAfterCommit,
} from "../../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { users } from "../../../../db/schema";
import { AccessService } from "../../../access/access.service";
import { EmailService } from "../../../email/email.service";
import { HrAutomationEngineService } from "../../automations/hr-automation-engine.service";

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
    private readonly email: EmailService,
    private readonly access: AccessService,
    private readonly automation: HrAutomationEngineService,
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
    const deliveries: Array<Promise<void>> = [];
    if (target.email) {
      deliveries.push(
        this.email.sendOnboardingWelcomeEmail(
          target.email,
          target.name ?? "there",
          target.designation ?? "Employee",
          this.joiningDateLabel(target.joiningDate),
          taskCount,
        ),
      );
    }

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
          .where(inArray(users.id, userIds));
        for (const recipient of recipients) {
          if (!recipient.email) continue;
          deliveries.push(
            this.email.sendOnboardingTaskEmail(
              recipient.email,
              recipient.name ?? "there",
              target.name ?? "the new joiner",
              "HR",
              hrTaskCount,
            ),
          );
        }
      }
    }

    const managerTaskCount = ownerRoleCounts.get("MANAGER") ?? 0;
    if (managerTaskCount > 0) {
      const [employee] = await this.db
        .select({ managerId: users.reportingTo })
        .from(users)
        .where(eq(users.id, target.id))
        .limit(1);
      if (employee?.managerId) {
        const [manager] = await this.db
          .select({ email: users.email, name: users.name })
          .from(users)
          .where(eq(users.id, employee.managerId))
          .limit(1);
        if (manager?.email) {
          deliveries.push(
            this.email.sendOnboardingTaskEmail(
              manager.email,
              manager.name ?? "there",
              target.name ?? "the new joiner",
              "Manager",
              managerTaskCount,
            ),
          );
        }
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
