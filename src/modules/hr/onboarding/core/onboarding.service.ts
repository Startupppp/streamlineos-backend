import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  leaveBalances,
  leaveTypes,
  onboardingTasks,
  onboardingTemplates,
  onboardingTemplateSteps,
  organizationMembers,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { HrAutomationEngineService } from "../../automations/hr-automation-engine.service";
import { OnboardingSessionService } from "../flow/onboarding-session.service";
import { PersonEmploymentSyncService } from "../../core/person-employment-sync.service";
import { EmailService } from "../../../email/email.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type {
  BankDetailsInput,
  CreateTemplateInput,
  InitiateInput,
  PersonalDetailsInput,
  UpdateTaskInput,
} from "./dto/onboarding.schemas";
import { OnboardingTemplateService } from "./onboarding-template.service";
import { OnboardingDetailsService } from "./onboarding-details.service";
import { OnboardingTaskService } from "./onboarding-task.service";
import { OnboardingAdminService } from "./onboarding-admin.service";
import { AccessService } from "../../../access/access.service";
import {
  hrEmploymentHistory,
  hrEmployments,
  hrPeople,
} from "../../../../db/schema/hr/core-people";

type DefaultTask = {
  title: string;
  description: string;
  ownerRole: string;
  dueOffsetDays: number;
  isComplianceItem: boolean;
};

const DEFAULT_TASKS: DefaultTask[] = [
  {
    title: "IT Setup",
    description: "Set up workstation, email, and required software access.",
    ownerRole: "IT",
    dueOffsetDays: 1,
    isComplianceItem: false,
  },
  {
    title: "HR Orientation",
    description:
      "Attend HR orientation session covering company policies and benefits.",
    ownerRole: "HR",
    dueOffsetDays: 2,
    isComplianceItem: false,
  },
  {
    title: "Department Intro",
    description: "Meet with the department head and team for a role overview.",
    ownerRole: "MANAGER",
    dueOffsetDays: 3,
    isComplianceItem: false,
  },
  {
    title: "Policy Review",
    description:
      "Read and acknowledge the employee handbook and code of conduct.",
    ownerRole: "NEW_HIRE",
    dueOffsetDays: 5,
    isComplianceItem: true,
  },
  {
    title: "Manager Introduction",
    description: "One-on-one meeting with direct manager to align on goals.",
    ownerRole: "MANAGER",
    dueOffsetDays: 7,
    isComplianceItem: false,
  },
  {
    title: "POSH Training Acknowledgement",
    description:
      "Complete mandatory Prevention of Sexual Harassment (POSH) awareness training and sign acknowledgement.",
    ownerRole: "NEW_HIRE",
    dueOffsetDays: 3,
    isComplianceItem: true,
  },
  {
    title: "Code of Conduct Sign-Off",
    description:
      "Read and digitally sign the company Code of Conduct document.",
    ownerRole: "NEW_HIRE",
    dueOffsetDays: 5,
    isComplianceItem: true,
  },
];

export type InitiateResult =
  | { error: "user_not_found" }
  | { error: "already_initiated" }
  | { success: true; tasksCreated: number; fromTemplate: boolean };

export function isInitiateUserNotFound(
  result: InitiateResult,
): result is { error: "user_not_found" } {
  return "error" in result && result.error === "user_not_found";
}

export function isInitiateAlreadyDone(
  result: InitiateResult,
): result is { error: "already_initiated" } {
  return "error" in result && result.error === "already_initiated";
}

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
    private readonly access: AccessService,
    private readonly tasks: OnboardingTaskService,
    private readonly admin: OnboardingAdminService,
    private readonly details: OnboardingDetailsService,
    private readonly sessions: OnboardingSessionService,
    private readonly templates: OnboardingTemplateService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly personEmploymentSync: PersonEmploymentSyncService,
  ) {}

  private async markEmploymentOnboarding(
    orgId: string,
    userId: string,
  ): Promise<void> {
    await this.personEmploymentSync.ensureFromUserId(orgId, userId, userId);

    const [row] = await this.db
      .select({
        employmentId: hrEmployments.id,
        lifecycleStatus: hrEmployments.lifecycleStatus,
      })
      .from(hrPeople)
      .innerJoin(
        hrEmployments,
        and(
          eq(hrEmployments.personId, hrPeople.id),
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .where(
        and(
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.userId, userId),
          isNull(hrPeople.deletedAt),
        ),
      )
      .limit(1);

    if (!row) return;

    const fromStatus = row.lifecycleStatus;
    if (fromStatus === "ONBOARDING") return;
    if (fromStatus !== "CANDIDATE" && fromStatus !== "PRE_JOINING") return;

    await this.db.transaction(async (tx) => {
      await tx.insert(hrEmploymentHistory).values({
        orgId,
        employmentId: row.employmentId,
        fromStatus,
        toStatus: "ONBOARDING",
        reason: "Onboarding checklist initiated",
        createdBy: userId,
      });
      await tx
        .update(hrEmployments)
        .set({ lifecycleStatus: "ONBOARDING" })
        .where(
          and(
            eq(hrEmployments.id, row.employmentId),
            eq(hrEmployments.orgId, orgId),
          ),
        );
    });
  }

  async initiate(orgId: string, input: InitiateInput): Promise<InitiateResult> {
    const [membership] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, input.userId),
          eq(organizationMembers.orgId, orgId),
        ),
      );

    if (!membership) {
      return { error: "user_not_found" };
    }

    const [targetUser] = await this.db
      .select({
        id: users.id,
        joiningDate: users.joiningDate,
        email: users.email,
        name: users.name,
        designation: users.designation,
        orgDepartmentId: users.orgDepartmentId,
      })
      .from(users)
      .where(eq(users.id, input.userId));

    const existing = await this.db
      .select({ id: onboardingTasks.id })
      .from(onboardingTasks)
      .where(
        and(
          eq(onboardingTasks.userId, input.userId),
          eq(onboardingTasks.orgId, orgId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      return { error: "already_initiated" };
    }

    await this.markEmploymentOnboarding(orgId, input.userId);

    const baseDate = targetUser?.joiningDate
      ? new Date(targetUser.joiningDate)
      : new Date();

    const employeeDeptId = targetUser?.orgDepartmentId ?? null;

    const allTemplates = await this.db
      .select({
        id: onboardingTemplates.id,
        departmentId: onboardingTemplates.departmentId,
      })
      .from(onboardingTemplates)
      .where(
        and(
          eq(onboardingTemplates.orgId, orgId),
          eq(onboardingTemplates.isActive, true),
          employeeDeptId !== null
            ? or(
                eq(onboardingTemplates.departmentId, employeeDeptId),
                isNull(onboardingTemplates.departmentId),
              )
            : isNull(onboardingTemplates.departmentId),
        ),
      );

    const template =
      allTemplates.find((t) => t.departmentId === employeeDeptId) ??
      allTemplates.find((t) => t.departmentId === null) ??
      null;

    if (template) {
      const steps = await this.db
        .select()
        .from(onboardingTemplateSteps)
        .where(eq(onboardingTemplateSteps.templateId, template.id))
        .orderBy(onboardingTemplateSteps.sortOrder);

      const otherTemplateIds = allTemplates
        .filter((t) => t.id !== template.id)
        .map((t) => t.id);

      let extraComplianceSteps: typeof steps = [];
      if (otherTemplateIds.length > 0) {
        extraComplianceSteps = await this.db
          .select()
          .from(onboardingTemplateSteps)
          .where(
            and(
              inArray(onboardingTemplateSteps.templateId, otherTemplateIds),
              eq(onboardingTemplateSteps.isComplianceItem, true),
            ),
          );
      }

      const allSteps = [...steps, ...extraComplianceSteps];

      if (allSteps.length > 0) {
        const taskInserts = allSteps.map((step) => {
          const due = new Date(baseDate);
          due.setDate(due.getDate() + step.dueOffsetDays);
          return {
            userId: input.userId,
            orgId,
            templateStepId: step.id,
            title: step.title,
            description: step.description,
            ownerRole: step.ownerRole,
            dueDate: due,
            status: "PENDING" as const,
          };
        });
        await this.db.insert(onboardingTasks).values(taskInserts);
        const ownerRoles = [...new Set(taskInserts.map((t) => t.ownerRole))];
        void this.dispatchOnboardingInitiatedEmails(
          orgId,
          input.userId,
          targetUser,
          ownerRoles,
        ).catch(() => undefined);
        void this.hrAutomation
          .emit(orgId, "employee.created", {
            userId: input.userId,
            employeeName: targetUser?.name ?? "",
            employeeEmail: targetUser?.email ?? "",
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
        return {
          success: true,
          tasksCreated: taskInserts.length,
          fromTemplate: true,
        };
      }
    }

    const defaultInserts = DEFAULT_TASKS.map((t) => {
      const due = new Date(baseDate);
      due.setDate(due.getDate() + t.dueOffsetDays);
      return {
        userId: input.userId,
        orgId,
        title: t.title,
        description: t.description,
        ownerRole: t.ownerRole,
        dueDate: due,
        status: "PENDING" as const,
      };
    });
    await this.db.insert(onboardingTasks).values(defaultInserts);
    const defaultOwnerRoles = [
      ...new Set(defaultInserts.map((t) => t.ownerRole)),
    ];
    void this.dispatchOnboardingInitiatedEmails(
      orgId,
      input.userId,
      targetUser,
      defaultOwnerRoles,
    ).catch(() => undefined);
    void this.hrAutomation
      .emit(orgId, "employee.created", {
        userId: input.userId,
        employeeName: targetUser?.name ?? "",
        employeeEmail: targetUser?.email ?? "",
        createdAt: new Date().toISOString(),
      })
      .catch(() => undefined);
    return {
      success: true,
      tasksCreated: defaultInserts.length,
      fromTemplate: false,
    };
  }

  private async dispatchOnboardingInitiatedEmails(
    orgId: string,
    employeeUserId: string,
    targetUser:
      | {
          email: string | null;
          name: string | null;
          designation: string | null;
          joiningDate: string | null;
        }
      | undefined,
    ownerRoles: string[],
  ): Promise<void> {
    if (targetUser?.email) {
      const joiningDate = targetUser.joiningDate
        ? new Date(targetUser.joiningDate).toLocaleDateString("en-IN", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })
        : new Date().toLocaleDateString("en-IN", {
            day: "numeric",
            month: "long",
            year: "numeric",
          });
      const taskCount = ownerRoles.length;
      await this.email.sendOnboardingWelcomeEmail(
        targetUser.email,
        targetUser.name ?? "there",
        targetUser.designation ?? "Employee",
        joiningDate,
        taskCount,
      );
    }

    const hrTaskCount = ownerRoles.filter((r) => r === "HR").length;
    const managerTaskCount = ownerRoles.filter((r) => r === "MANAGER").length;
    if (hrTaskCount === 0 && managerTaskCount === 0) return;

    const employeeName = targetUser?.name ?? "the new joiner";

    if (hrTaskCount > 0) {
      const hrHolders = await this.access.membersWithPermission(
        orgId,
        "hr:onboarding:manage",
      );
      const hrUserIds = hrHolders
        .map((m) => m.userId)
        .filter((id) => id !== employeeUserId);
      if (hrUserIds.length > 0) {
        const hrUsers = await this.db
          .select({ userId: users.id, email: users.email, name: users.name })
          .from(users)
          .where(inArray(users.id, hrUserIds));
        const seen = new Set<string>();
        for (const member of hrUsers) {
          if (!member.email || seen.has(member.userId)) continue;
          seen.add(member.userId);
          await this.email.sendOnboardingTaskEmail(
            member.email,
            member.name ?? "there",
            employeeName,
            "HR",
            hrTaskCount,
          );
        }
      }
    }

    if (managerTaskCount > 0) {
      const orgAdminRows = await this.db
        .select({
          userId: organizationMembers.userId,
          email: users.email,
          name: users.name,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.isOwner, true),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        );
      const seen = new Set<string>();
      for (const member of orgAdminRows) {
        if (
          !member.email ||
          member.userId === employeeUserId ||
          seen.has(member.userId)
        )
          continue;
        seen.add(member.userId);
        await this.email.sendOnboardingTaskEmail(
          member.email,
          member.name ?? "there",
          employeeName,
          "Manager",
          managerTaskCount,
        );
      }
    }
  }

  async submit(orgId: string, userId: string) {
    await this.details.upsertOnboardingStep(userId, orgId, "Final Review");

    const currentYear = new Date().getFullYear();

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ onboardingCompletedAt: new Date() })
        .where(eq(users.id, userId));

      const existingBalance = await tx.query.leaveBalances.findFirst({
        where: and(
          eq(leaveBalances.orgId, orgId),
          eq(leaveBalances.userId, userId),
          eq(leaveBalances.year, currentYear),
        ),
      });

      if (!existingBalance) {
        const orgLeaveTypes = await tx.query.leaveTypes.findMany({
          where: eq(leaveTypes.orgId, orgId),
        });

        if (orgLeaveTypes.length > 0) {
          await tx.insert(leaveBalances).values(
            orgLeaveTypes.map((lt) => ({
              orgId,
              userId,
              leaveTypeId: lt.id,
              balance: String(lt.daysPerYear),
              year: currentYear,
            })),
          );
        }
      }
    });

    await this.details.invalidateSessionCache(userId);
    await this.sessions.completeSession(orgId, userId, "employee_onboarding");

    return { success: true };
  }

  getProgressSummary(orgId: string) {
    return this.admin.getProgressSummary(orgId);
  }

  sendReminders(orgId: string, appUrl: string) {
    return this.admin.sendReminders(orgId, appUrl);
  }

  listTemplateDepartments(orgId: string) {
    return this.templates.listTemplateDepartments(orgId);
  }

  listTemplates(orgId: string) {
    return this.templates.listTemplates(orgId);
  }

  createTemplate(orgId: string, userId: string, input: CreateTemplateInput) {
    return this.templates.createTemplate(orgId, userId, input);
  }

  savePersonalDetails(
    orgId: string,
    userId: string,
    input: PersonalDetailsInput,
  ) {
    return this.details.savePersonalDetails(orgId, userId, input);
  }

  getPersonalDetails(orgId: string, userId: string) {
    return this.details.getPersonalDetails(orgId, userId);
  }

  saveBankDetails(orgId: string, userId: string, input: BankDetailsInput) {
    return this.details.saveBankDetails(orgId, userId, input);
  }

  getBankDetails(orgId: string, userId: string) {
    return this.details.getBankDetails(orgId, userId);
  }

  getStatus(userId: string, orgId: string) {
    return this.details.getStatus(userId, orgId);
  }

  getUserTasks(u: CurrentUserContext, userId: string) {
    return this.tasks.getUserTasks(u, userId);
  }

  updateTask(u: CurrentUserContext, taskId: number, input: UpdateTaskInput) {
    return this.tasks.updateTask(u, taskId, input);
  }
}
