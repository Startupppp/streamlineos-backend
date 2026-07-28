import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  onboardingTasks,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import { AutomationService } from "../automation/automation.service";
import { HrAutomationEngineService } from "../hr-automations/hr-automation-engine.service";
import { OnboardingProbationService } from "./onboarding-probation.service";
import { EmailService } from "../email/email.service";
import { logger } from "../../common/logger/logger.service";
import { HR_NOTIFY_ROLES } from "../hr-lifecycle/hr-role-constants";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { UpdateTaskInput } from "./dto/onboarding.schemas";

@Injectable()
export class OnboardingTaskService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly probation: OnboardingProbationService,
  ) {}

  async getUserTasks(u: CurrentUserContext, userId: string) {
    let isAdmin = u.isOrgOwner || u.isPlatformAdmin;
    if (!isAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      isAdmin = perms.has("hr:employees:manage");
    }

    if (!isAdmin && u.userId !== userId) {
      throw new ForbiddenException("Forbidden");
    }

    return this.db
      .select()
      .from(onboardingTasks)
      .where(
        and(
          eq(onboardingTasks.userId, userId),
          eq(onboardingTasks.orgId, u.orgId),
        ),
      )
      .orderBy(onboardingTasks.createdAt);
  }

  async updateTask(
    u: CurrentUserContext,
    taskId: number,
    input: UpdateTaskInput,
  ) {
    const [task] = await this.db
      .select()
      .from(onboardingTasks)
      .where(
        and(eq(onboardingTasks.id, taskId), eq(onboardingTasks.orgId, u.orgId)),
      );

    if (!task) throw new NotFoundException("Task not found");

    let isAdmin = u.isOrgOwner || u.isPlatformAdmin;
    if (!isAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      isAdmin = perms.has("hr:employees:manage");
    }

    if (!isAdmin && task.userId !== u.userId) {
      throw new ForbiddenException("Forbidden");
    }

    const now = new Date();
    await this.db
      .update(onboardingTasks)
      .set({
        status: input.status,
        completedAt: input.status === "COMPLETED" ? now : null,
        completedBy: input.status === "COMPLETED" ? u.userId : null,
      })
      .where(eq(onboardingTasks.id, taskId));

    if (input.status === "COMPLETED") {
      this.dispatchOnboardingComplete(u.orgId, task.userId);
    }

    return { success: true };
  }

  private dispatchOnboardingComplete(
    orgId: string,
    employeeUserId: string,
  ): void {
    void (async () => {
      const pending = await this.db
        .select({ id: onboardingTasks.id })
        .from(onboardingTasks)
        .where(
          and(
            eq(onboardingTasks.userId, employeeUserId),
            eq(onboardingTasks.orgId, orgId),
            eq(onboardingTasks.status, "PENDING"),
          ),
        );
      if (pending.length > 0) return;

      try {
        await this.probation.setupProbationForUser(orgId, employeeUserId);
      } catch {
        logger.warn("onboarding probation setup failed", {
          orgId,
          employeeUserId,
        });
      }

      const employee = await this.db.query.users.findFirst({
        where: eq(users.id, employeeUserId),
        columns: { email: true, name: true },
      });

      if (employee?.email) {
        await this.email.sendOnboardingCompleteEmployeeEmail(
          employee.email,
          employee.name ?? "Team Member",
        );
      }

      const hrMembers = await this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            inArray(organizationMembers.role, [...HR_NOTIFY_ROLES]),
          ),
        );
      if (hrMembers.length === 0) return;

      const hrUsers = await this.db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(
          inArray(
            users.id,
            hrMembers.map((m) => m.userId),
          ),
        );

      const recipients = hrUsers.filter(
        (m): m is { email: string; name: string | null } => Boolean(m.email),
      );
      await Promise.all(
        recipients.map((m) =>
          this.email.sendOnboardingCompleteHrEmail(
            m.email,
            m.name ?? "HR",
            employee?.name ?? "Employee",
          ),
        ),
      );

      const onboardedPayload = {
        userId: employeeUserId,
        employeeName: employee?.name ?? "",
        employeeEmail: employee?.email ?? "",
        totalTasks: 0,
        completedAt: new Date().toISOString(),
      };
      void this.automation
        .runAutomationsForEvent(orgId, "onboarding.completed", onboardedPayload)
        .catch(() => undefined);
      void this.hrAutomation
        .emit(orgId, "employee.onboarded", onboardedPayload)
        .catch(() => undefined);
    })().catch(() => undefined);
  }
}
