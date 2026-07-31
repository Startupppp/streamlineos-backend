import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, isNull, lte, sql } from "drizzle-orm";
import {
  hrEffectiveDatedChanges,
  hrEmployments,
  hrEmployeeSensitiveFields,
  hrReportingLines,
  hrPeople,
} from "../../../db/schema/hr/core-people";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type {
  CreateEffectiveDateChangeInput,
  ListEffectiveDateChangesInput,
} from "./dto/hr-core.schemas";
import { HrAuditService } from "./hr-audit.service";
import { HrWorkflowEngineService } from "../workflows/hr-workflow-engine.service";

@Injectable()
export class HrEffectiveChangesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
    private readonly workflowEngine: HrWorkflowEngineService,
  ) {}

  async create(orgId: string, actorId: string, input: CreateEffectiveDateChangeInput) {
    const [employment] = await this.db
      .select({ id: hrEmployments.id, subjectUserId: hrPeople.userId })
      .from(hrEmployments)
      .innerJoin(hrPeople, eq(hrEmployments.personId, hrPeople.id))
      .where(
        and(
          eq(hrEmployments.id, input.employmentId),
          eq(hrEmployments.orgId, orgId),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .limit(1);
    if (!employment) throw new NotFoundException("Employment not found");

    const [created] = await this.db
      .insert(hrEffectiveDatedChanges)
      .values({
        orgId,
        employmentId: input.employmentId,
        changeType: input.changeType,
        oldValue: input.oldValue ?? null,
        newValue: input.newValue,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        notes: input.notes ?? null,
        createdBy: actorId,
        status: "draft",
      })
      .returning();

    if (!created) throw new Error("Failed to create effective-dated change");

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_effective_dated_changes",
      entityId: String(created.id),
      action: "created",
      after: created,
    });

    if (employment.subjectUserId) {
      try {
        const instance = await this.workflowEngine.startWorkflow({
          orgId,
          objectType: "employee_data_change",
          objectId: String(created.id),
          requestedByUserId: actorId,
          subjectEmployeeId: employment.subjectUserId,
          context: {
            changeType: created.changeType,
            effectiveFrom: created.effectiveFrom,
            employmentId: created.employmentId,
          },
        });
        if (instance.status === "approved") {
          return this.approve(orgId, created.id, actorId);
        }
      } catch {
        await this.audit.log({
          orgId,
          actorId,
          entityType: "hr_effective_dated_changes",
          entityId: String(created.id),
          action: "workflow_start_failed",
        });
      }
    }

    return created;
  }

  async list(orgId: string, input: ListEffectiveDateChangesInput) {
    const { page, limit, employmentId, changeType, status } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrEffectiveDatedChanges.orgId, orgId)];
    if (employmentId) conditions.push(eq(hrEffectiveDatedChanges.employmentId, employmentId));
    if (changeType) conditions.push(eq(hrEffectiveDatedChanges.changeType, changeType));
    if (status) conditions.push(eq(hrEffectiveDatedChanges.status, status));

    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrEffectiveDatedChanges)
        .where(where)
        .orderBy(hrEffectiveDatedChanges.effectiveFrom)
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrEffectiveDatedChanges).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async approve(orgId: string, changeId: number, actorId: string) {
    const [change] = await this.db
      .select({
        id: hrEffectiveDatedChanges.id,
        status: hrEffectiveDatedChanges.status,
      })
      .from(hrEffectiveDatedChanges)
      .where(
        and(
          eq(hrEffectiveDatedChanges.id, changeId),
          eq(hrEffectiveDatedChanges.orgId, orgId),
        ),
      )
      .limit(1);

    if (!change) throw new NotFoundException("Effective-dated change not found");

    const [updated] = await this.db
      .update(hrEffectiveDatedChanges)
      .set({
        status: "approved",
        approvedBy: actorId,
        approvedAt: new Date(),
      })
      .where(and(eq(hrEffectiveDatedChanges.id, changeId), eq(hrEffectiveDatedChanges.orgId, orgId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_effective_dated_changes",
      entityId: String(changeId),
      action: "approved",
      before: { status: change.status },
      after: { status: "approved" },
    });

    return updated;
  }

  async applyDueChanges(orgId: string, asOfDate?: string): Promise<{ applied: number }> {
    const cutoff = asOfDate ? new Date(asOfDate) : new Date();

    const dueChanges = await this.db
      .select({
        id: hrEffectiveDatedChanges.id,
        employmentId: hrEffectiveDatedChanges.employmentId,
        changeType: hrEffectiveDatedChanges.changeType,
        newValue: hrEffectiveDatedChanges.newValue,
        effectiveFrom: hrEffectiveDatedChanges.effectiveFrom,
      })
      .from(hrEffectiveDatedChanges)
      .where(
        and(
          eq(hrEffectiveDatedChanges.orgId, orgId),
          eq(hrEffectiveDatedChanges.status, "approved"),
          lte(hrEffectiveDatedChanges.effectiveFrom, cutoff.toISOString().slice(0, 10)),
          isNull(hrEffectiveDatedChanges.appliedAt),
        ),
      );

    if (dueChanges.length === 0) return { applied: 0 };

    let applied = 0;

    await this.db.transaction(async (tx) => {
      for (const change of dueChanges) {
        const newVal = change.newValue as Record<string, unknown> | null;
        if (!newVal) continue;

        let didApply = false;

        if (change.changeType === "department" && typeof newVal["departmentId"] === "string") {
          await tx
            .update(hrEmployments)
            .set({ departmentId: newVal["departmentId"] })
            .where(
              and(
                eq(hrEmployments.id, change.employmentId),
                eq(hrEmployments.orgId, orgId),
              ),
            );
          didApply = true;
        } else if (change.changeType === "designation" && typeof newVal["designation"] === "string") {
          await tx
            .update(hrEmployments)
            .set({ designation: newVal["designation"] })
            .where(
              and(
                eq(hrEmployments.id, change.employmentId),
                eq(hrEmployments.orgId, orgId),
              ),
            );
          didApply = true;
        } else if (change.changeType === "job_level" && typeof newVal["jobLevelId"] === "number") {
          await tx
            .update(hrEmployments)
            .set({ jobLevelId: newVal["jobLevelId"] })
            .where(
              and(
                eq(hrEmployments.id, change.employmentId),
                eq(hrEmployments.orgId, orgId),
              ),
            );
          didApply = true;
        } else if (change.changeType === "location" && typeof newVal["locationId"] === "string") {
          await tx
            .update(hrEmployments)
            .set({ locationId: String(newVal["locationId"]) })
            .where(
              and(
                eq(hrEmployments.id, change.employmentId),
                eq(hrEmployments.orgId, orgId),
              ),
            );
          didApply = true;
        } else if (change.changeType === "employment_type" && typeof newVal["employmentTypeId"] === "number") {
          await tx
            .update(hrEmployments)
            .set({ employmentTypeId: newVal["employmentTypeId"] })
            .where(
              and(
                eq(hrEmployments.id, change.employmentId),
                eq(hrEmployments.orgId, orgId),
              ),
            );
          didApply = true;
        } else if (change.changeType === "compensation" && typeof newVal["salaryCents"] === "number") {
          await tx
            .update(hrEmployeeSensitiveFields)
            .set({ salaryAmountCents: newVal["salaryCents"] })
            .where(
              and(
                eq(hrEmployeeSensitiveFields.employmentId, change.employmentId),
                eq(hrEmployeeSensitiveFields.orgId, orgId),
              ),
            );
          didApply = true;
        } else if (change.changeType === "manager" && typeof newVal["managerEmploymentId"] === "number") {
          await tx
            .update(hrReportingLines)
            .set({ effectiveTo: change.effectiveFrom })
            .where(
              and(
                eq(hrReportingLines.employmentId, change.employmentId),
                eq(hrReportingLines.orgId, orgId),
                eq(hrReportingLines.lineType, "primary"),
                isNull(hrReportingLines.effectiveTo),
              ),
            );
          await tx.insert(hrReportingLines).values({
            orgId,
            employmentId: change.employmentId,
            managerEmploymentId: newVal["managerEmploymentId"],
            lineType: "primary",
            effectiveFrom: change.effectiveFrom,
          });
          didApply = true;
        }

        if (didApply) {
          await tx
            .update(hrEffectiveDatedChanges)
            .set({ status: "applied", appliedAt: sql`now()` })
            .where(
              and(
                eq(hrEffectiveDatedChanges.id, change.id),
                eq(hrEffectiveDatedChanges.orgId, orgId),
              ),
            );
          applied++;
        }
      }
    });

    return { applied };
  }
}
