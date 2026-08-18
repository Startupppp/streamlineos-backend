import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import {
  hrEmploymentHistory,
  hrEmployments,
  onboardingTasks,
  onboardingTemplates,
  onboardingTemplateSteps,
  organizationMembers,
  users,
} from "../../../../db/schema";
import { PersonEmploymentSyncService } from "../../core/person-employment-sync.service";
import type { InitiateInput } from "./dto/onboarding.schemas";
import { OnboardingInitiationDispatchService } from "./onboarding-initiation-dispatch.service";

type DefaultTask = {
  title: string;
  description: string;
  ownerRole: "IT" | "HR" | "MANAGER" | "NEW_HIRE";
  dueOffsetDays: number;
  isComplianceItem: boolean;
};

const DEFAULT_TASKS: DefaultTask[] = [
  { title: "IT Setup", description: "Set up workstation, email, and required software access.", ownerRole: "IT", dueOffsetDays: 1, isComplianceItem: false },
  { title: "HR Orientation", description: "Attend HR orientation session covering company policies and benefits.", ownerRole: "HR", dueOffsetDays: 2, isComplianceItem: false },
  { title: "Department Intro", description: "Meet with the department head and team for a role overview.", ownerRole: "MANAGER", dueOffsetDays: 3, isComplianceItem: false },
  { title: "Policy Review", description: "Read and acknowledge the employee handbook and code of conduct.", ownerRole: "NEW_HIRE", dueOffsetDays: 5, isComplianceItem: true },
  { title: "Manager Introduction", description: "Meet with the direct manager to align on goals.", ownerRole: "MANAGER", dueOffsetDays: 7, isComplianceItem: false },
  { title: "POSH Training Acknowledgement", description: "Complete POSH awareness training and acknowledge completion.", ownerRole: "NEW_HIRE", dueOffsetDays: 3, isComplianceItem: true },
  { title: "Code of Conduct Sign-Off", description: "Read and digitally sign the company Code of Conduct.", ownerRole: "NEW_HIRE", dueOffsetDays: 5, isComplianceItem: true },
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
export class OnboardingInitiationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly employmentSync: PersonEmploymentSyncService,
    private readonly dispatch: OnboardingInitiationDispatchService,
  ) {}

  async initiate(orgId: string, actorId: string, input: InitiateInput): Promise<InitiateResult> {
    const outcome = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${orgId}:${input.userId}:onboarding`}, 0))`,
      );

      const [membership] = await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, input.userId),
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .limit(1);
      if (!membership) return { error: "user_not_found" } as const;

      const [target] = await tx
        .select({
          id: users.id,
          joiningDate: users.joiningDate,
          email: users.email,
          name: users.name,
          designation: users.designation,
          orgDepartmentId: users.orgDepartmentId,
        })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!target) return { error: "user_not_found" } as const;

      const [existing] = await tx
        .select({ id: onboardingTasks.id })
        .from(onboardingTasks)
        .where(
          and(eq(onboardingTasks.userId, input.userId), eq(onboardingTasks.orgId, orgId)),
        )
        .limit(1);
      if (existing) return { error: "already_initiated" } as const;

      const employment = await this.employmentSync.ensureFromUserId(
        orgId,
        actorId,
        input.userId,
        tx,
        "ONBOARDING",
      );
      if (!employment) return { error: "user_not_found" } as const;
      await this.markEmploymentOnboarding(tx, orgId, actorId, employment.employmentId);

      const taskValues = await this.buildTaskValues(
        tx,
        orgId,
        input.userId,
        target.orgDepartmentId,
        target.joiningDate,
      );
      await tx.insert(onboardingTasks).values(taskValues.values);

      return {
        success: true,
        tasksCreated: taskValues.values.length,
        fromTemplate: taskValues.fromTemplate,
        target,
        ownerRoleCounts: this.ownerRoleCounts(taskValues.values),
      } as const;
    });

    if ("error" in outcome) return outcome;
    this.dispatch.schedule(
      orgId,
      outcome.target,
      outcome.tasksCreated,
      outcome.ownerRoleCounts,
    );
    return {
      success: true,
      tasksCreated: outcome.tasksCreated,
      fromTemplate: outcome.fromTemplate,
    };
  }

  private async markEmploymentOnboarding(
    tx: Db,
    orgId: string,
    actorId: string,
    employmentId: number,
  ): Promise<void> {
    const [employment] = await tx
      .select({ status: hrEmployments.lifecycleStatus })
      .from(hrEmployments)
      .where(
        and(
          eq(hrEmployments.id, employmentId),
          eq(hrEmployments.orgId, orgId),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!employment || employment.status === "ONBOARDING") return;
    if (employment.status !== "CANDIDATE" && employment.status !== "PRE_JOINING") return;

    await tx.insert(hrEmploymentHistory).values({
      orgId,
      employmentId,
      fromStatus: employment.status,
      toStatus: "ONBOARDING",
      reason: "Onboarding checklist initiated",
      createdBy: actorId,
    });
    await tx
      .update(hrEmployments)
      .set({
        lifecycleStatus: "ONBOARDING",
        rowVersion: sql`${hrEmployments.rowVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hrEmployments.id, employmentId),
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.lifecycleStatus, employment.status),
        ),
      );
  }

  private async buildTaskValues(
    tx: Db,
    orgId: string,
    userId: string,
    departmentId: string | null,
    joiningDate: string | null,
  ) {
    const templates = await tx
      .select({ id: onboardingTemplates.id, departmentId: onboardingTemplates.departmentId })
      .from(onboardingTemplates)
      .where(
        and(
          eq(onboardingTemplates.orgId, orgId),
          eq(onboardingTemplates.isActive, true),
          departmentId
            ? or(
                eq(onboardingTemplates.departmentId, departmentId),
                isNull(onboardingTemplates.departmentId),
              )
            : isNull(onboardingTemplates.departmentId),
        ),
      );
    const selected =
      templates.find((template) => template.departmentId === departmentId) ??
      templates.find((template) => template.departmentId === null);

    const baseDate = joiningDate ? new Date(`${joiningDate}T00:00:00`) : new Date();
    if (!selected) return { values: this.defaultTaskValues(orgId, userId, baseDate), fromTemplate: false };

    const selectedSteps = await tx
      .select()
      .from(onboardingTemplateSteps)
      .where(eq(onboardingTemplateSteps.templateId, selected.id))
      .orderBy(onboardingTemplateSteps.sortOrder);
    const otherIds = templates.filter((template) => template.id !== selected.id).map((template) => template.id);
    const extraCompliance = otherIds.length === 0
      ? []
      : await tx
          .select()
          .from(onboardingTemplateSteps)
          .where(
            and(
              inArray(onboardingTemplateSteps.templateId, otherIds),
              eq(onboardingTemplateSteps.isComplianceItem, true),
            ),
          );
    const steps = [...selectedSteps, ...extraCompliance];
    if (steps.length === 0) {
      return { values: this.defaultTaskValues(orgId, userId, baseDate), fromTemplate: false };
    }

    return {
      values: steps.map((step) => ({
        userId,
        orgId,
        templateStepId: step.id,
        title: step.title,
        description: step.description,
        ownerRole: step.ownerRole,
        dueDate: this.dueDate(baseDate, step.dueOffsetDays),
        status: "PENDING" as const,
      })),
      fromTemplate: true,
    };
  }

  private defaultTaskValues(orgId: string, userId: string, baseDate: Date) {
    return DEFAULT_TASKS.map((task) => ({
      userId,
      orgId,
      title: task.title,
      description: task.description,
      ownerRole: task.ownerRole,
      dueDate: this.dueDate(baseDate, task.dueOffsetDays),
      status: "PENDING" as const,
    }));
  }

  private dueDate(baseDate: Date, offsetDays: number): Date {
    const due = new Date(baseDate);
    due.setDate(due.getDate() + offsetDays);
    return due;
  }

  private ownerRoleCounts(values: ReadonlyArray<{ ownerRole: string }>): Map<string, number> {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value.ownerRole, (counts.get(value.ownerRole) ?? 0) + 1);
    return counts;
  }
}
