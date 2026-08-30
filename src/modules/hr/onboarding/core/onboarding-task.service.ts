import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  eq,
  getTableColumns,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  onboardingTasks,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import {
  registerAfterCommit,
} from "../../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { applyScope } from "../../../access/apply-scope";
import { AccessService, broadest } from "../../../access/access.service";
import type { DataScope } from "../../../access/access.types";
import { AutomationService } from "../../../automation/automation.service";
import { HrAutomationEngineService } from "../../automations/hr-automation-engine.service";
import { OnboardingProbationService } from "./onboarding-probation.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { logger } from "../../../../common/logger/logger.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { UpdateTaskInput } from "./dto/onboarding.schemas";
import { resolveCompatibleList } from "../../../../common/db/expand-contract-compat";
import { loadOnboardingTaskDependencies } from "./onboarding-task-dependency-compat";

const TASKS_VIEW_PERMISSION = "hr:onboarding:tasks:view";
const TASKS_COMPLETE_PERMISSION = "hr:onboarding:tasks:complete";
const ONBOARDING_MANAGE_PERMISSION = "hr:onboarding:manage";
const EMPLOYEES_MANAGE_PERMISSION = "hr:employees:manage";
const ASSETS_MANAGE_PERMISSION = "hr:assets:manage";

interface TaskAccess {
  canView: boolean;
  canComplete: boolean;
  onboardingScope: DataScope;
  employeeManageScope: DataScope;
  canManageAssets: boolean;
}

@Injectable()
export class OnboardingTaskService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly dispatch: NotificationDispatchService,
    private readonly automation: AutomationService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly probation: OnboardingProbationService,
  ) {}

  private async resolveTaskAccess(
    currentUser: CurrentUserContext,
  ): Promise<TaskAccess> {
    const permissions = await this.access.resolveUserPermissions(
      currentUser.orgId,
      currentUser.userId,
    );
    return {
      canView: permissions.has(TASKS_VIEW_PERMISSION),
      canComplete: permissions.has(TASKS_COMPLETE_PERMISSION),
      onboardingScope:
        permissions.get(ONBOARDING_MANAGE_PERMISSION) ?? "none",
      employeeManageScope:
        permissions.get(EMPLOYEES_MANAGE_PERMISSION) ?? "none",
      canManageAssets: permissions.has(ASSETS_MANAGE_PERMISSION),
    };
  }

  private completionScope(
    currentUser: CurrentUserContext,
    access: TaskAccess,
  ): SQL {
    const branches: SQL[] = [
      and(
        eq(onboardingTasks.ownerRole, "NEW_HIRE"),
        eq(onboardingTasks.userId, currentUser.userId),
      )!,
    ];

    if (access.onboardingScope !== "none") {
      // HR onboarding managers are the explicit administrative override, but
      // their configured own/team/all scope still applies to the employee.
      branches.push(
        applyScope(access.onboardingScope, currentUser.orgId, currentUser.userId, {
          ownerColumn: onboardingTasks.userId,
        }),
      );
    }
    if (access.employeeManageScope !== "none") {
      branches.push(
        and(
          eq(onboardingTasks.ownerRole, "MANAGER"),
          applyScope(access.employeeManageScope, currentUser.orgId, currentUser.userId, {
            ownerColumn: onboardingTasks.userId,
          }),
        )!,
      );
    }
    if (access.canManageAssets) {
      branches.push(eq(onboardingTasks.ownerRole, "IT"));
    }

    return or(...branches) ?? sql`false`;
  }

  async getUserTasks(currentUser: CurrentUserContext, userId: string) {
    const access = await this.resolveTaskAccess(currentUser);
    if (!access.canView) {
      throw new ForbiddenException("Forbidden");
    }

    const subjectScope = broadest(
      access.onboardingScope,
      access.employeeManageScope,
    );
    if (currentUser.userId !== userId && subjectScope === "none") {
      throw new ForbiddenException("Forbidden");
    }

    const canComplete = access.canComplete
      ? this.completionScope(currentUser, access)
      : sql<boolean>`false`;

    const tasks = await this.db
      .select({ ...getTableColumns(onboardingTasks), canComplete })
      .from(onboardingTasks)
      .where(
        and(
          eq(onboardingTasks.userId, userId),
          eq(onboardingTasks.orgId, currentUser.orgId),
          currentUser.userId === userId
            ? eq(onboardingTasks.userId, currentUser.userId)
            : applyScope(subjectScope, currentUser.orgId, currentUser.userId, {
                ownerColumn: onboardingTasks.userId,
              }),
        ),
      )
      .orderBy(onboardingTasks.createdAt);
    const dependenciesByTaskId = await loadOnboardingTaskDependencies(
      this.db,
      currentUser.orgId,
      tasks.map((task) => task.id),
    );
    return tasks.map((task) => ({
      ...task,
      dependsOnTaskIds:
        task.dependsOnTaskIds === null
          ? null
          : resolveCompatibleList(
              task.dependsOnTaskIds,
              dependenciesByTaskId.get(task.id),
            ),
    }));
  }

  async updateTask(
    currentUser: CurrentUserContext,
    taskId: number,
    input: UpdateTaskInput,
  ) {
    const access = await this.resolveTaskAccess(currentUser);
    if (!access.canComplete) {
      throw new ForbiddenException("Forbidden");
    }

    const result = await this.db.transaction(async (tx) => {
      const [task] = await tx
        .select({
          id: onboardingTasks.id,
          userId: onboardingTasks.userId,
          ownerRole: onboardingTasks.ownerRole,
          status: onboardingTasks.status,
        })
        .from(onboardingTasks)
        .where(
          and(
            eq(onboardingTasks.id, taskId),
            eq(onboardingTasks.orgId, currentUser.orgId),
            this.completionScope(currentUser, access),
          ),
        )
        .limit(1);

      if (!task) throw new NotFoundException("Task not found");
      if (task.status === input.status) {
        return { completed: false, employeeUserId: task.userId };
      }

      const now = new Date();
      const [updated] = await tx
        .update(onboardingTasks)
        .set({
          status: input.status,
          completedAt: input.status === "COMPLETED" ? now : null,
          completedBy: input.status === "COMPLETED" ? currentUser.userId : null,
          rowVersion: sql`${onboardingTasks.rowVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(onboardingTasks.id, taskId),
            eq(onboardingTasks.orgId, currentUser.orgId),
            eq(onboardingTasks.userId, task.userId),
            eq(onboardingTasks.ownerRole, task.ownerRole),
            eq(onboardingTasks.status, task.status),
          ),
        )
        .returning({ id: onboardingTasks.id });

      if (!updated) {
        throw new ConflictException(
          "This onboarding task changed. Refresh and try again.",
        );
      }
      return {
        completed: input.status === "COMPLETED",
        employeeUserId: task.userId,
      };
    });

    if (result.completed) {
      this.scheduleOnboardingComplete(currentUser.orgId, result.employeeUserId);
    }

    return { success: true };
  }

  private scheduleOnboardingComplete(
    orgId: string,
    employeeUserId: string,
  ): void {
    const dispatch = () =>
      runInNewTenantTransaction(this.db, orgId, () =>
        this.dispatchOnboardingComplete(orgId, employeeUserId),
      ).catch((error: unknown) => {
        logger.warn("onboarding completion dispatch failed", {
          orgId,
          employeeUserId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });
    if (!registerAfterCommit(dispatch)) void dispatch();
  }

  private async dispatchOnboardingComplete(
    orgId: string,
    employeeUserId: string,
  ): Promise<void> {
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
      columns: { id: true, name: true, email: true },
    });

    if (employee) await this.dispatch.emit({
      eventKey: "hr.onboarding.completed",
      orgId,
      targetUserIds: [employee.id],
      entityType: "employee",
      entityId: employeeUserId,
      message: "Your onboarding is complete.",
      variables: { employeeName: employee.name ?? "Team Member" },
    });

    const hrMembers = await this.access.membersWithPermission(
      orgId,
      ONBOARDING_MANAGE_PERMISSION,
    );

    if (hrMembers.length > 0) {
      const hrUsers = await this.db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, hrMembers.map((m) => m.userId)));

      await this.dispatch.emit({
        eventKey: "hr.onboarding.completed",
        orgId,
        targetUserIds: hrUsers.map((m) => m.id),
        entityType: "employee",
        entityId: employeeUserId,
        message: `${employee?.name ?? "An employee"} completed onboarding.`,
        variables: { employeeName: employee?.name ?? "Employee" },
      });
    }

    const onboardedPayload = {
      userId: employeeUserId,
      employeeName: employee?.name ?? "",
      employeeEmail: employee?.email ?? "",
      totalTasks: 0,
      completedAt: new Date().toISOString(),
    };
    await Promise.all([
      this.automation.runAutomationsForEvent(
        orgId,
        "onboarding.completed",
        onboardedPayload,
      ),
      this.hrAutomation.emit(orgId, "employee.onboarded", onboardedPayload),
    ]);
  }
}
