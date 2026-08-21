import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, gt, isNull, lte } from "drizzle-orm";
import {
  hrEffectiveDatedChanges,
  hrEmployments,
  hrEmployeeSensitiveFields,
  hrReportingLines,
  hrPeople,
  OPEN_ENDED_DATE,
} from "../../../db/schema/hr/core-people";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type {
  ApplyDueChangesInput,
  CreateEffectiveDateChangeInput,
  ListEffectiveDateChangesInput,
} from "./dto/hr-core.schemas";
import { HrAuditService } from "./hr-audit.service";
import { HrWorkflowEngineService } from "../workflows/hr-workflow-engine.service";
import { HrEffectiveChangeApplierService } from "./hr-effective-change-applier.service";

type EmploymentSnapshot = {
  id: number;
  subjectUserId: string | null;
  departmentId: string | null;
  designation: string | null;
  jobLevelId: number | null;
  locationId: string | null;
};

@Injectable()
export class HrEffectiveChangesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
    private readonly workflowEngine: HrWorkflowEngineService,
    private readonly applier: HrEffectiveChangeApplierService,
  ) {}

  async create(
    orgId: string,
    actorId: string,
    input: CreateEffectiveDateChangeInput,
    tx?: Db,
  ) {
    if (tx) return this.createInTransaction(tx, orgId, actorId, input);
    return this.db.transaction((transaction) =>
      this.createInTransaction(transaction, orgId, actorId, input),
    );
  }

  private async createInTransaction(
    tx: Db,
    orgId: string,
    actorId: string,
    input: CreateEffectiveDateChangeInput,
  ) {
      const [employment] = await tx
        .select({
          id: hrEmployments.id,
          subjectUserId: hrPeople.userId,
          departmentId: hrEmployments.departmentId,
          designation: hrEmployments.designation,
          jobLevelId: hrEmployments.jobLevelId,
          locationId: hrEmployments.locationId,
        })
        .from(hrEmployments)
        .innerJoin(
          hrPeople,
          and(eq(hrPeople.orgId, hrEmployments.orgId), eq(hrPeople.id, hrEmployments.personId)),
        )
        .where(
          and(
            eq(hrEmployments.id, input.employmentId),
            eq(hrEmployments.orgId, orgId),
            isNull(hrEmployments.deletedAt),
            isNull(hrPeople.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!employment) throw new NotFoundException("Employment not found.");

      const oldValue = await this.snapshotOldValue(tx, orgId, input, employment);
      const [created] = await tx
        .insert(hrEffectiveDatedChanges)
        .values({
          orgId,
          employmentId: input.employmentId,
          changeType: input.changeType,
          oldValue,
          newValue: input.newValue,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? OPEN_ENDED_DATE,
          notes: input.notes ?? null,
          createdBy: actorId,
          status: "draft",
        })
        .returning();
      if (!created) throw new ConflictException("Failed to create effective-dated change.");

      await this.audit.log(
        {
          orgId,
          actorId,
          entityType: "hr_effective_dated_changes",
          entityId: String(created.id),
          action: "created",
          after: created,
        },
        tx,
      );

      if (!employment.subjectUserId) return created;
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
        tx,
      });
      if (instance.status !== "approved") return created;

      const [approved] = await tx
        .update(hrEffectiveDatedChanges)
        .set({ status: "approved", approvedBy: actorId, approvedAt: new Date() })
        .where(
          and(
            eq(hrEffectiveDatedChanges.id, created.id),
            eq(hrEffectiveDatedChanges.orgId, orgId),
            eq(hrEffectiveDatedChanges.status, "draft"),
          ),
        )
        .returning();
      if (!approved) throw new ConflictException("The effective change could not be approved.");
      await this.audit.log(
        {
          orgId,
          actorId,
          entityType: "hr_effective_dated_changes",
          entityId: String(created.id),
          action: "approved",
          before: { status: "draft" },
          after: { status: "approved" },
        },
        tx,
      );
      return approved;
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
        .orderBy(desc(hrEffectiveDatedChanges.effectiveFrom), desc(hrEffectiveDatedChanges.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrEffectiveDatedChanges).where(where),
    ]);
    const total = totalResult[0]?.total ?? 0;
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async approve(orgId: string, changeId: number, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [change] = await tx
        .select({ id: hrEffectiveDatedChanges.id, status: hrEffectiveDatedChanges.status })
        .from(hrEffectiveDatedChanges)
        .where(
          and(
            eq(hrEffectiveDatedChanges.id, changeId),
            eq(hrEffectiveDatedChanges.orgId, orgId),
          ),
        )
        .limit(1)
        .for("update");
      if (!change) throw new NotFoundException("Effective-dated change not found.");
      if (change.status !== "draft") {
        throw new ConflictException(`Only draft changes can be approved; this change is ${change.status}.`);
      }

      const [updated] = await tx
        .update(hrEffectiveDatedChanges)
        .set({ status: "approved", approvedBy: actorId, approvedAt: new Date() })
        .where(
          and(
            eq(hrEffectiveDatedChanges.id, changeId),
            eq(hrEffectiveDatedChanges.orgId, orgId),
            eq(hrEffectiveDatedChanges.status, "draft"),
            isNull(hrEffectiveDatedChanges.appliedAt),
          ),
        )
        .returning();
      if (!updated) throw new ConflictException("The effective change was already updated.");
      await this.audit.log(
        {
          orgId,
          actorId,
          entityType: "hr_effective_dated_changes",
          entityId: String(changeId),
          action: "approved",
          before: { status: change.status },
          after: { status: "approved" },
        },
        tx,
      );
      return updated;
    });
  }

  applyDueChanges(orgId: string, actorId: string | null, input: ApplyDueChangesInput) {
    return this.applier.applyDue(orgId, actorId, input.asOfDate, input.limit);
  }

  private async snapshotOldValue(
    tx: Db,
    orgId: string,
    input: CreateEffectiveDateChangeInput,
    employment: EmploymentSnapshot,
  ): Promise<Record<string, unknown>> {
    if (input.changeType === "department") return { departmentId: employment.departmentId };
    if (input.changeType === "location") return { locationId: employment.locationId };
    if (input.changeType === "designation") return { designation: employment.designation };
    if (input.changeType === "job_level") return { jobLevelId: employment.jobLevelId };
    if (input.changeType === "compensation") {
      const [sensitive] = await tx
        .select({ salaryCents: hrEmployeeSensitiveFields.salaryAmountCents })
        .from(hrEmployeeSensitiveFields)
        .where(
          and(
            eq(hrEmployeeSensitiveFields.orgId, orgId),
            eq(hrEmployeeSensitiveFields.employmentId, employment.id),
          ),
        )
        .limit(1);
      return { salaryCents: sensitive?.salaryCents ?? null };
    }

    const today = new Date().toISOString().slice(0, 10);
    const [line] = await tx
      .select({ managerEmploymentId: hrReportingLines.managerEmploymentId })
      .from(hrReportingLines)
      .where(
        and(
          eq(hrReportingLines.orgId, orgId),
          eq(hrReportingLines.employmentId, employment.id),
          eq(hrReportingLines.lineType, "primary"),
          lte(hrReportingLines.effectiveFrom, today),
          gt(hrReportingLines.effectiveTo, today),
        ),
      )
      .orderBy(desc(hrReportingLines.effectiveFrom), desc(hrReportingLines.id))
      .limit(1);
    return { managerEmploymentId: line?.managerEmploymentId ?? null };
  }
}
