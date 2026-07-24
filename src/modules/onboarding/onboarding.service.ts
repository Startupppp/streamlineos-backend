import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  users,
  departments,
  documents,
  leaveTypes,
  leaveBalances,
  notifications,
  onboardingSteps,
  onboardingTasks,
  departmentMembers,
  onboardingTemplates,
  onboardingTemplateSteps,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AutomationService } from "../automation/automation.service";
import { HrAutomationEngineService } from "../hr-automations/hr-automation-engine.service";
import { OnboardingProbationService } from "./onboarding-probation.service";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";
import { AccessService } from "../access/access.service";
import { getOnboardingReminderEmailTemplate } from "../email/templates/notifications-misc";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type {
  BankDetailsInput,
  CreateTemplateInput,
  InitiateInput,
  PersonalDetailsInput,
  UpdateTaskInput,
} from "./dto/onboarding.schemas";
import { encrypt, encryptBankDetails } from "./crypto.helpers";
import { resolveCountryRequirements } from "./onboarding-requirements.catalog";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { OnboardingSessionService } from "../onboarding-flow/onboarding-session.service";
import { HR_NOTIFY_ROLES } from "../hr-lifecycle/hr-role-constants";
import { PersonEmploymentSyncService } from "../hr-core/person-employment-sync.service";
import { hrEmployments, hrPeople, hrEmploymentHistory } from "../../db/schema/hr/core-people";

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
    private readonly automation: AutomationService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly sessions: OnboardingSessionService,
    private readonly probation: OnboardingProbationService,
    private readonly cache: CacheService,
    private readonly personEmploymentSync: PersonEmploymentSyncService,
  ) {}

  private async markEmploymentOnboarding(orgId: string, userId: string): Promise<void> {
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
        .where(and(eq(hrEmployments.id, row.employmentId), eq(hrEmployments.orgId, orgId)));
    });
  }

  async getProgressSummary(orgId: string) {
    const rows = await this.db
      .select({
        userId: onboardingTasks.userId,
        userName: users.name,
        totalTasks: sql<number>`count(*)::int`,
        completedTasks: sql<number>`sum(case when ${onboardingTasks.status} = 'COMPLETED' then 1 else 0 end)::int`,
        lastCompletedAt: sql<
          string | null
        >`max(${onboardingTasks.completedAt})`,
      })
      .from(onboardingTasks)
      .leftJoin(users, eq(onboardingTasks.userId, users.id))
      .where(eq(onboardingTasks.orgId, orgId))
      .groupBy(onboardingTasks.userId, users.name);

    return rows.map((r) => ({
      userId: r.userId,
      userName: r.userName ?? r.userId,
      totalTasks: r.totalTasks,
      completedTasks: r.completedTasks ?? 0,
      percentComplete:
        r.totalTasks > 0
          ? Math.round(((r.completedTasks ?? 0) / r.totalTasks) * 100)
          : 0,
      lastCompletedAt: r.lastCompletedAt ?? null,
    }));
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

    const [deptMember] = await this.db
      .select({ departmentId: departmentMembers.departmentId })
      .from(departmentMembers)
      .where(eq(departmentMembers.userId, input.userId))
      .limit(1);

    const employeeDeptId = deptMember?.departmentId ?? null;

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

    const ASSIGNABLE_TASK_ROLES = ["HR", "MANAGER"] as const;
    const assignableRoles = ownerRoles.filter(
      (r): r is (typeof ASSIGNABLE_TASK_ROLES)[number] =>
        (ASSIGNABLE_TASK_ROLES as readonly string[]).includes(r),
    );
    if (assignableRoles.length === 0) return;

    const tasksByRole = new Map<string, number>();
    for (const role of assignableRoles) {
      tasksByRole.set(role, ownerRoles.filter((r) => r === role).length);
    }

    const membersRaw = await this.db
      .select({
        userId: organizationMembers.userId,
        role: organizationMembers.role,
        email: users.email,
        name: users.name,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          inArray(organizationMembers.role, assignableRoles),
        ),
      );

    const employeeName = targetUser?.name ?? "the new joiner";
    const seen = new Set<string>();
    for (const member of membersRaw) {
      if (
        !member.email ||
        member.userId === employeeUserId ||
        seen.has(member.userId)
      )
        continue;
      seen.add(member.userId);
      const count = tasksByRole.get(member.role) ?? 1;
      await this.email.sendOnboardingTaskEmail(
        member.email,
        member.name ?? "there",
        employeeName,
        member.role,
        count,
      );
    }
  }

  async listTemplateDepartments(orgId: string) {
    return this.db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(eq(departments.orgId, orgId));
  }

  async listTemplates(orgId: string) {
    const templates = await this.db
      .select()
      .from(onboardingTemplates)
      .where(eq(onboardingTemplates.orgId, orgId))
      .orderBy(onboardingTemplates.createdAt);

    const templateIds = templates.map((t) => t.id);
    const steps =
      templateIds.length > 0
        ? await this.db
            .select()
            .from(onboardingTemplateSteps)
            .where(inArray(onboardingTemplateSteps.templateId, templateIds))
            .orderBy(onboardingTemplateSteps.sortOrder)
        : [];

    const stepsMap = new Map<number, typeof steps>();
    for (const step of steps) {
      const existing = stepsMap.get(step.templateId) ?? [];
      existing.push(step);
      stepsMap.set(step.templateId, existing);
    }

    return templates.map((t) => ({
      ...t,
      steps: stepsMap.get(t.id) ?? [],
    }));
  }

  createTemplate(orgId: string, userId: string, input: CreateTemplateInput) {
    return this.db.transaction(async (tx) => {
      const [template] = await tx
        .insert(onboardingTemplates)
        .values({
          orgId,
          name: input.name,
          departmentId: input.departmentId ?? null,
          description: input.description ?? null,
          isActive: true,
          createdBy: userId,
        })
        .returning();

      if (!template) {
        throw new Error("Failed to create template");
      }

      if (input.steps.length > 0) {
        await tx.insert(onboardingTemplateSteps).values(
          input.steps.map((step, i) => ({
            templateId: template.id,
            title: step.title,
            description: step.description ?? null,
            ownerRole: step.ownerRole,
            dueOffsetDays: step.dueOffsetDays,
            isRequired: step.isRequired,
            isComplianceItem: step.isComplianceItem,
            sortOrder: i,
          })),
        );
      }

      return { success: true, templateId: template.id };
    });
  }

  async savePersonalDetails(
    orgId: string,
    userId: string,
    input: PersonalDetailsInput,
  ) {
    const emergencyContact =
      input.emergencyName && input.emergencyRelation && input.emergencyPhone
        ? {
            name: input.emergencyName,
            relation: input.emergencyRelation,
            phone: input.emergencyPhone,
          }
        : undefined;

    await this.db
      .update(users)
      .set({
        phone: input.phone,
        ...(input.gender ? { gender: input.gender } : {}),
        ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
        ...(emergencyContact ? { emergencyContact } : {}),
      })
      .where(eq(users.id, userId));

    await this.upsertOnboardingStep(userId, orgId, "Personal Details");

    return { success: true };
  }

  async getPersonalDetails(orgId: string, userId: string) {
    const [user] = await this.db
      .select({
        phone: users.phone,
        gender: users.gender,
        dateOfBirth: users.dateOfBirth,
        emergencyContact: users.emergencyContact,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);

    if (!user) {
      throw new NotFoundException("User not found in this organization");
    }

    return {
      phone: user.phone,
      gender: user.gender,
      dateOfBirth: user.dateOfBirth,
      emergencyName: user.emergencyContact?.name ?? null,
      emergencyRelation: user.emergencyContact?.relation ?? null,
      emergencyPhone: user.emergencyContact?.phone ?? null,
    };
  }

  async saveBankDetails(
    orgId: string,
    userId: string,
    input: BankDetailsInput,
  ) {
    const req = resolveCountryRequirements(input.countryCode);
    const statutory = input.statutory ?? {};
    const primaryKey = req.statutoryFields[0]?.key;
    const primaryTaxId =
      input.taxId?.trim() ||
      (primaryKey ? statutory[primaryKey]?.trim() : "") ||
      "";

    await this.db
      .update(users)
      .set({
        bankDetails: encryptBankDetails({
          accountNumber: input.accountNumber ?? "",
          bankName: input.bankName,
          branch: input.branch ?? "",
          ifsc: req.bankScheme === "IFSC" ? (input.routingCode ?? "") : "",
          accountHolder: input.accountHolder,
          bankCountry: req.countryCode,
          scheme: req.bankScheme,
          routingCode: input.routingCode?.trim() || undefined,
          iban: input.iban?.trim() || undefined,
          swift: input.swift?.trim() || undefined,
          pfUanNumber: statutory["uan"]?.trim() || undefined,
          statutory: Object.keys(statutory).length > 0 ? statutory : undefined,
        }),
        ...(primaryTaxId ? { taxId: encrypt(primaryTaxId) } : {}),
      })
      .where(eq(users.id, userId));

    await this.upsertOnboardingStep(userId, orgId, "Bank Details");

    return { success: true };
  }

  async submit(orgId: string, userId: string) {
    await this.upsertOnboardingStep(userId, orgId, "Final Review");

    await this.db
      .update(users)
      .set({ onboardingCompletedAt: new Date() })
      .where(eq(users.id, userId));

    await this.cache.invalidate(CACHE_KEYS.userSession(userId));

    await this.sessions.completeSession(orgId, userId, "employee_onboarding");

    const currentYear = new Date().getFullYear();
    const existingBalance = await this.db.query.leaveBalances.findFirst({
      where: and(
        eq(leaveBalances.userId, userId),
        eq(leaveBalances.year, currentYear),
      ),
    });

    if (!existingBalance) {
      const orgLeaveTypes = await this.db.query.leaveTypes.findMany({
        where: eq(leaveTypes.orgId, orgId),
      });

      if (orgLeaveTypes.length > 0) {
        await this.db.insert(leaveBalances).values(
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

    return { success: true };
  }

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

  async sendReminders(
    orgId: string,
    appUrl: string,
  ): Promise<{ sent: number; total: number }> {
    const incompleteUsers = await this.db
      .select({
        userId: onboardingTasks.userId,
        userName: users.name,
        userEmail: users.email,
        totalTasks: count(),
        pendingTasks: sql<number>`COUNT(CASE WHEN ${onboardingTasks.status} != 'COMPLETED' THEN 1 END)::int`,
      })
      .from(onboardingTasks)
      .innerJoin(users, eq(onboardingTasks.userId, users.id))
      .where(eq(onboardingTasks.orgId, orgId))
      .groupBy(onboardingTasks.userId, users.name, users.email)
      .having(
        sql`COUNT(CASE WHEN ${onboardingTasks.status} != 'COMPLETED' THEN 1 END) > 0`,
      );

    if (incompleteUsers.length === 0) {
      return { sent: 0, total: 0 };
    }

    let sentCount = 0;

    for (const user of incompleteUsers) {
      await this.db.insert(notifications).values({
        orgId,
        userId: user.userId,
        type: "WARNING",
        title: "Onboarding Reminder",
        message: `You have ${user.pendingTasks} pending onboarding task(s). Please complete them at your earliest convenience.`,
        link: "/hr/onboarding/my-tasks",
      });

      if (user.userEmail) {
        try {
          await this.email.sendEmail({
            to: user.userEmail,
            subject: "Onboarding reminder — pending tasks",
            html: getOnboardingReminderEmailTemplate(
              user.userName ?? "there",
              user.pendingTasks,
              user.totalTasks,
            ),
          });
          sentCount++;
        } catch {}
      }
    }

    return { sent: sentCount, total: incompleteUsers.length };
  }

  async getStatus(
    userId: string,
    orgId: string,
  ): Promise<{
    personalDetails: boolean;
    bankDetails: boolean;
    documents: number;
    submitted: boolean;
  }> {
    const [stepsResult, docCountResult, userRow] = await Promise.all([
      this.db
        .select({
          stepName: onboardingSteps.stepName,
          status: onboardingSteps.status,
        })
        .from(onboardingSteps)
        .where(
          and(
            eq(onboardingSteps.userId, userId),
            eq(onboardingSteps.orgId, orgId),
          ),
        ),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(documents)
        .where(and(eq(documents.userId, userId), eq(documents.orgId, orgId))),
      this.db
        .select({ onboardingCompletedAt: users.onboardingCompletedAt })
        .from(users)
        .where(eq(users.id, userId)),
    ]);

    const completedSteps = new Set(
      stepsResult
        .filter((s) => s.status === "COMPLETED")
        .map((s) => s.stepName),
    );

    return {
      personalDetails: completedSteps.has("Personal Details"),
      bankDetails: completedSteps.has("Bank Details"),
      documents: docCountResult[0]?.count ?? 0,
      submitted: Boolean(userRow[0]?.onboardingCompletedAt),
    };
  }

  private async upsertOnboardingStep(
    userId: string,
    orgId: string,
    stepName: string,
  ) {
    const existing = await this.db.query.onboardingSteps.findFirst({
      where: and(
        eq(onboardingSteps.userId, userId),
        eq(onboardingSteps.stepName, stepName),
      ),
    });
    if (existing) {
      await this.db
        .update(onboardingSteps)
        .set({ status: "COMPLETED", completedAt: new Date() })
        .where(eq(onboardingSteps.id, existing.id));
    } else {
      await this.db.insert(onboardingSteps).values({
        userId,
        orgId,
        stepName,
        status: "COMPLETED",
        completedAt: new Date(),
      });
    }
  }
}
