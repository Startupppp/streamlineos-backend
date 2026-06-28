import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  departmentMembers,
  leaveBalances,
  leaveTypes,
  onboardingSteps,
  onboardingTasks,
  onboardingTemplates,
  onboardingTemplateSteps,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type {
  BankDetailsInput,
  CreateTemplateInput,
  InitiateInput,
  PersonalDetailsInput,
  UpdateTaskInput,
} from "./dto/onboarding.schemas";
import { encrypt, encryptBankDetails } from "./crypto.helpers";

type DefaultTask = {
  title: string;
  description: string;
  ownerRole: string;
  dueOffsetDays: number;
  isComplianceItem: boolean;
};

const DEFAULT_TASKS: DefaultTask[] = [
  { title: "IT Setup", description: "Set up workstation, email, and required software access.", ownerRole: "IT", dueOffsetDays: 1, isComplianceItem: false },
  { title: "HR Orientation", description: "Attend HR orientation session covering company policies and benefits.", ownerRole: "HR", dueOffsetDays: 2, isComplianceItem: false },
  { title: "Department Intro", description: "Meet with the department head and team for a role overview.", ownerRole: "MANAGER", dueOffsetDays: 3, isComplianceItem: false },
  { title: "Policy Review", description: "Read and acknowledge the employee handbook and code of conduct.", ownerRole: "NEW_HIRE", dueOffsetDays: 5, isComplianceItem: true },
  { title: "Manager Introduction", description: "One-on-one meeting with direct manager to align on goals.", ownerRole: "MANAGER", dueOffsetDays: 7, isComplianceItem: false },
  { title: "POSH Training Acknowledgement", description: "Complete mandatory Prevention of Sexual Harassment (POSH) awareness training and sign acknowledgement.", ownerRole: "NEW_HIRE", dueOffsetDays: 3, isComplianceItem: true },
  { title: "Code of Conduct Sign-Off", description: "Read and digitally sign the company Code of Conduct document.", ownerRole: "NEW_HIRE", dueOffsetDays: 5, isComplianceItem: true },
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
  ) {}

  async getProgressSummary(orgId: string) {
    const rows = await this.db
      .select({
        userId: onboardingTasks.userId,
        userName: users.name,
        totalTasks: sql<number>`count(*)::int`,
        completedTasks: sql<number>`sum(case when ${onboardingTasks.status} = 'COMPLETED' then 1 else 0 end)::int`,
        lastCompletedAt: sql<string | null>`max(${onboardingTasks.completedAt})`,
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
      .select({ id: users.id, joiningDate: users.joiningDate })
      .from(users)
      .where(eq(users.id, input.userId));

    const existing = await this.db
      .select({ id: onboardingTasks.id })
      .from(onboardingTasks)
      .where(and(eq(onboardingTasks.userId, input.userId), eq(onboardingTasks.orgId, orgId)))
      .limit(1);

    if (existing.length > 0) {
      return { error: "already_initiated" };
    }

    const baseDate = targetUser?.joiningDate ? new Date(targetUser.joiningDate) : new Date();

    const [deptMember] = await this.db
      .select({ departmentId: departmentMembers.departmentId })
      .from(departmentMembers)
      .where(eq(departmentMembers.userId, input.userId))
      .limit(1);

    const employeeDeptId = deptMember?.departmentId ?? null;

    const allTemplates = await this.db
      .select({ id: onboardingTemplates.id, departmentId: onboardingTemplates.departmentId })
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
        return { success: true, tasksCreated: taskInserts.length, fromTemplate: true };
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
    return { success: true, tasksCreated: defaultInserts.length, fromTemplate: false };
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

  async savePersonalDetails(orgId: string, userId: string, input: PersonalDetailsInput) {
    const skillsArray = Array.isArray(input.skills)
      ? input.skills
      : input.skills
        ? input.skills.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;

    await this.db
      .update(users)
      .set({
        phone: input.phone,
        ...(input.gender ? { gender: input.gender } : {}),
        ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
        ...(input.experienceYears ? { experienceYears: input.experienceYears } : {}),
        ...(skillsArray ? { skills: skillsArray } : {}),
      })
      .where(eq(users.id, userId));

    await this.upsertOnboardingStep(userId, orgId, "Personal Details");

    return { success: true };
  }

  async saveBankDetails(orgId: string, userId: string, input: BankDetailsInput) {
    await this.db
      .update(users)
      .set({
        bankDetails: encryptBankDetails({
          accountNumber: input.accountNumber,
          bankName: input.bankName,
          branch: input.branch ?? "",
          ifsc: input.ifsc,
          accountHolder: input.accountHolder,
        }),
        ...(input.taxId ? { taxId: encrypt(input.taxId) } : {}),
      })
      .where(eq(users.id, userId));

    await this.upsertOnboardingStep(userId, orgId, "Bank Details");

    return { success: true };
  }

  async submit(orgId: string, userId: string) {
    await this.upsertOnboardingStep(userId, orgId, "Final Review");

    const currentYear = new Date().getFullYear();
    const existingBalance = await this.db.query.leaveBalances.findFirst({
      where: and(eq(leaveBalances.userId, userId), eq(leaveBalances.year, currentYear)),
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

  getUserTasks(u: CurrentUserContext, userId: string) {
    const isAdmin = u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("hr:employees:manage");

    if (!isAdmin && u.userId !== userId) {
      throw new ForbiddenException("Forbidden");
    }

    return this.db
      .select()
      .from(onboardingTasks)
      .where(and(eq(onboardingTasks.userId, userId), eq(onboardingTasks.orgId, u.orgId)))
      .orderBy(onboardingTasks.createdAt);
  }

  async updateTask(u: CurrentUserContext, taskId: number, input: UpdateTaskInput) {
    const [task] = await this.db
      .select()
      .from(onboardingTasks)
      .where(and(eq(onboardingTasks.id, taskId), eq(onboardingTasks.orgId, u.orgId)));

    if (!task) throw new NotFoundException("Task not found");

    const isAdmin = u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("hr:employees:manage");

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

  private dispatchOnboardingComplete(orgId: string, employeeUserId: string): void {
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

      const employee = await this.db.query.users.findFirst({
        where: eq(users.id, employeeUserId),
        columns: { email: true, name: true },
      });

      if (employee?.email) {
        await this.email.sendOnboardingCompleteEmployeeEmail(employee.email, employee.name ?? "Team Member");
      }

      const hrMembers = await this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "HR")));
      if (hrMembers.length === 0) return;

      const hrUsers = await this.db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(inArray(users.id, hrMembers.map((m) => m.userId)));

      const recipients = hrUsers.filter((m): m is { email: string; name: string | null } => Boolean(m.email));
      await Promise.all(
        recipients.map((m) =>
          this.email.sendOnboardingCompleteHrEmail(m.email, m.name ?? "HR", employee?.name ?? "Employee"),
        ),
      );
    })().catch(() => undefined);
  }

  private async upsertOnboardingStep(userId: string, orgId: string, stepName: string) {
    const existing = await this.db.query.onboardingSteps.findFirst({
      where: and(eq(onboardingSteps.userId, userId), eq(onboardingSteps.stepName, stepName)),
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
