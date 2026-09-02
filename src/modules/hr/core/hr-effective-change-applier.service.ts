import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, gt, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { assertActiveOrgUnit, syncOrgUnitPlacement } from "../../../common/org/sync-org-unit-placement";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrEffectiveDatedChanges,
  hrEmployeeSensitiveFields,
  hrEmployments,
  hrPeople,
  hrReportingLines,
  OPEN_ENDED_DATE,
} from "../../../db/schema/hr/core-people";
import { hrJobLevels } from "../../../db/schema/hr/core-org";
import { HrAuditService } from "./hr-audit.service";

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!isRecordValue(value)) {
    throw new ConflictException("The stored effective change payload is invalid.");
  }
  return value;
}

function stringValue(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new ConflictException("The stored effective change payload is invalid.");
  }
  return field;
}

function numberValue(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new ConflictException("The stored effective change payload is invalid.");
  }
  return field;
}

@Injectable()
export class HrEffectiveChangeApplierService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async applyDue(
    orgId: string,
    actorId: string | null,
    asOfDate: string | undefined,
    limit: number,
  ): Promise<{ applied: number; hasMore: boolean }> {
    const cutoff = asOfDate ?? new Date().toISOString().slice(0, 10);

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${orgId}:effective-changes`}, 0))`,
      );

      const due = await tx
        .select({
          id: hrEffectiveDatedChanges.id,
          employmentId: hrEffectiveDatedChanges.employmentId,
          changeType: hrEffectiveDatedChanges.changeType,
          oldValue: hrEffectiveDatedChanges.oldValue,
          newValue: hrEffectiveDatedChanges.newValue,
          effectiveFrom: hrEffectiveDatedChanges.effectiveFrom,
          effectiveTo: hrEffectiveDatedChanges.effectiveTo,
        })
        .from(hrEffectiveDatedChanges)
        .where(
          and(
            eq(hrEffectiveDatedChanges.orgId, orgId),
            eq(hrEffectiveDatedChanges.status, "approved"),
            lte(hrEffectiveDatedChanges.effectiveFrom, cutoff),
            isNull(hrEffectiveDatedChanges.appliedAt),
            inArray(hrEffectiveDatedChanges.changeType, [
              "department",
              "manager",
              "location",
              "designation",
              "job_level",
              "compensation",
            ]),
          ),
        )
        .orderBy(asc(hrEffectiveDatedChanges.effectiveFrom), asc(hrEffectiveDatedChanges.id))
        .limit(limit)
        .for("update");

      for (const change of due) await this.applyOne(tx, orgId, change);

      if (due.length > 0) {
        const marked = await tx
          .update(hrEffectiveDatedChanges)
          .set({ status: "applied", appliedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              inArray(
                hrEffectiveDatedChanges.id,
                due.map((change) => change.id),
              ),
              eq(hrEffectiveDatedChanges.orgId, orgId),
              eq(hrEffectiveDatedChanges.status, "approved"),
              isNull(hrEffectiveDatedChanges.appliedAt),
            ),
          )
          .returning({ id: hrEffectiveDatedChanges.id });
        if (marked.length !== due.length)
          throw new ConflictException("The effective change was already processed.");
      }

      for (const change of due) {
        await this.audit.log(
          {
            orgId,
            actorId,
            entityType: "hr_effective_dated_changes",
            entityId: String(change.id),
            action: "applied",
            before: change.oldValue,
            after: change.newValue,
          },
          tx,
        );
      }

      return { applied: due.length, hasMore: due.length === limit };
    });
  }

  private async applyOne(
    tx: Db,
    orgId: string,
    change: {
      employmentId: number;
      changeType: string;
      newValue: unknown;
      effectiveFrom: string;
      effectiveTo: string;
    },
  ): Promise<void> {
    const [employment] = await tx
      .select({ id: hrEmployments.id, userId: hrPeople.userId })
      .from(hrEmployments)
      .innerJoin(
        hrPeople,
        and(eq(hrPeople.orgId, hrEmployments.orgId), eq(hrPeople.id, hrEmployments.personId)),
      )
      .where(
        and(
          eq(hrEmployments.id, change.employmentId),
          eq(hrEmployments.orgId, orgId),
          isNull(hrEmployments.deletedAt),
          isNull(hrPeople.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!employment) throw new NotFoundException("Employment not found.");

    const value = recordValue(change.newValue);
    if (change.changeType === "department") {
      const departmentId = stringValue(value, "departmentId");
      await assertActiveOrgUnit(tx, orgId, departmentId, "DEPARTMENT");
      await this.updateEmployment(tx, orgId, change.employmentId, { departmentId });
      if (employment.userId) {
        await syncOrgUnitPlacement(tx, orgId, employment.userId, { DEPARTMENT: departmentId });
      }
      return;
    }

    if (change.changeType === "location") {
      const locationId = stringValue(value, "locationId");
      await assertActiveOrgUnit(tx, orgId, locationId, "LOCATION");
      await this.updateEmployment(tx, orgId, change.employmentId, { locationId });
      if (employment.userId) {
        await syncOrgUnitPlacement(tx, orgId, employment.userId, { LOCATION: locationId });
      }
      return;
    }

    if (change.changeType === "designation") {
      await this.updateEmployment(tx, orgId, change.employmentId, {
        designation: stringValue(value, "designation"),
      });
      return;
    }

    if (change.changeType === "job_level") {
      const jobLevelId = numberValue(value, "jobLevelId");
      const [level] = await tx
        .select({ id: hrJobLevels.id })
        .from(hrJobLevels)
        .where(
          and(
            eq(hrJobLevels.id, jobLevelId),
            eq(hrJobLevels.orgId, orgId),
            eq(hrJobLevels.isActive, true),
          ),
        )
        .limit(1);
      if (!level) throw new BadRequestException("Invalid job level selection.");
      await this.updateEmployment(tx, orgId, change.employmentId, { jobLevelId });
      return;
    }

    if (change.changeType === "compensation") {
      const salaryAmountCents = numberValue(value, "salaryCents");
      await tx
        .insert(hrEmployeeSensitiveFields)
        .values({ orgId, employmentId: change.employmentId, salaryAmountCents })
        .onConflictDoUpdate({
          target: hrEmployeeSensitiveFields.employmentId,
          set: { salaryAmountCents, updatedAt: new Date() },
        });
      return;
    }

    if (change.changeType === "manager") {
      const managerEmploymentId = numberValue(value, "managerEmploymentId");
      await this.applyManager(tx, orgId, change, managerEmploymentId);
      return;
    }

    throw new ConflictException("The effective change type cannot be applied.");
  }

  private async updateEmployment(
    tx: Db,
    orgId: string,
    employmentId: number,
    values: Partial<typeof hrEmployments.$inferInsert>,
  ): Promise<void> {
    const [updated] = await tx
      .update(hrEmployments)
      .set({
        ...values,
        rowVersion: sql`${hrEmployments.rowVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hrEmployments.id, employmentId),
          eq(hrEmployments.orgId, orgId),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .returning({ id: hrEmployments.id });
    if (!updated) throw new ConflictException("The employment changed before this update applied.");
  }

  private async applyManager(
    tx: Db,
    orgId: string,
    change: { employmentId: number; effectiveFrom: string; effectiveTo: string },
    managerEmploymentId: number,
  ): Promise<void> {
    if (managerEmploymentId === change.employmentId) {
      throw new BadRequestException("An employee cannot report to themselves.");
    }
    const [manager] = await tx
      .select({ id: hrEmployments.id })
      .from(hrEmployments)
      .where(
        and(
          eq(hrEmployments.id, managerEmploymentId),
          eq(hrEmployments.orgId, orgId),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .limit(1);
    if (!manager) throw new BadRequestException("Invalid manager selection.");

    const [cycle] = await tx.execute<{ creates_cycle: boolean }>(sql`
      WITH RECURSIVE manager_chain AS (
        SELECT ${managerEmploymentId}::integer AS employment_id,
               ARRAY[${managerEmploymentId}::integer] AS path
        UNION ALL
        SELECT line.manager_employment_id, chain.path || line.manager_employment_id
        FROM manager_chain chain
        INNER JOIN hr_reporting_lines line
          ON line.org_id = ${orgId}
         AND line.employment_id = chain.employment_id
         AND line.line_type = 'primary'
         AND line.effective_from <= ${change.effectiveFrom}::date
         AND line.effective_to > ${change.effectiveFrom}::date
        WHERE NOT line.manager_employment_id = ANY(chain.path)
          AND cardinality(chain.path) < 1000
      )
      SELECT EXISTS (
        SELECT 1 FROM manager_chain WHERE employment_id = ${change.employmentId}
      ) AS creates_cycle
    `);
    if (cycle?.creates_cycle) {
      throw new BadRequestException("This reporting structure would create a circular chain.");
    }

    const [sameStart] = await tx
      .select({ id: hrReportingLines.id })
      .from(hrReportingLines)
      .where(
        and(
          eq(hrReportingLines.orgId, orgId),
          eq(hrReportingLines.employmentId, change.employmentId),
          eq(hrReportingLines.lineType, "primary"),
          eq(hrReportingLines.effectiveFrom, change.effectiveFrom),
        ),
      )
      .limit(1);
    if (sameStart) throw new ConflictException("A manager change already starts on this date.");

    await tx
      .update(hrReportingLines)
      .set({ effectiveTo: change.effectiveFrom })
      .where(
        and(
          eq(hrReportingLines.orgId, orgId),
          eq(hrReportingLines.employmentId, change.employmentId),
          eq(hrReportingLines.lineType, "primary"),
          lt(hrReportingLines.effectiveFrom, change.effectiveFrom),
          gt(hrReportingLines.effectiveTo, change.effectiveFrom),
        ),
      );

    await tx.insert(hrReportingLines).values({
      orgId,
      employmentId: change.employmentId,
      managerEmploymentId,
      lineType: "primary",
      effectiveFrom: change.effectiveFrom,
      effectiveTo: change.effectiveTo || OPEN_ENDED_DATE,
    });
  }
}
