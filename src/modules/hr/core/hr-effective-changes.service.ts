import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";
import { decodeCursor, buildCursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeValue } from "../../../common/pagination/keyset";
import {
  hrEffectiveDatedChanges,
  hrEmployments,
  hrEmployeeSensitiveFields,
  hrReportingLines,
  hrPeople,
  OPEN_ENDED_DATE,
} from "../../../db/schema/hr/core-people";
import { organizationMembers } from "../../../db/schema/common/auth";
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
import { boundHrReadLimit } from "../hr-read-limits";

type EmploymentSnapshot = {
  id: number;
  subjectUserId: string | null;
  departmentId: string | null;
  designation: string | null;
  jobLevelId: number | null;
  locationId: string | null;
};

type EffectiveChangeCursorScope = {
  orgId: string;
  employmentId: number | null;
  changeType: string | null;
  status: string | null;
};

function invalidEffectiveChangeCursor(): never {
  throw new BadRequestException({
    code: "INVALID_EFFECTIVE_CHANGE_CURSOR",
    message: "The effective change cursor is invalid or expired.",
  });
}

function isBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function decodeEffectiveChangeCursor(
  value: string | undefined,
  expected: EffectiveChangeCursorScope,
) {
  if (!value) return null;
  const position = decodeCursor(value);
  if (!position || !isBusinessDate(position.sortValue))
    return invalidEffectiveChangeCursor();

  try {
    const scope: unknown = JSON.parse(position.id);
    if (
      !Array.isArray(scope) ||
      scope.length !== 5 ||
      typeof scope[0] !== "number" ||
      !Number.isSafeInteger(scope[0]) ||
      scope[0] < 1 ||
      scope[1] !== expected.orgId ||
      scope[2] !== expected.employmentId ||
      scope[3] !== expected.changeType ||
      scope[4] !== expected.status
    )
      return invalidEffectiveChangeCursor();
    return { sortValue: position.sortValue, id: String(scope[0]) };
  } catch {
    return invalidEffectiveChangeCursor();
  }
}

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

  private async resolveActorMembershipId(
    tx: Db,
    orgId: string,
    actorId: string,
  ): Promise<number | null> {
    const [row] = await tx
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, actorId),
        ),
      )
      .limit(1);
    return row?.id ?? null;
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

      const actorMembershipId = await this.resolveActorMembershipId(tx, orgId, actorId);
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
          createdByMembershipId: actorMembershipId,
          status: "draft",
        })
        .returning();
      if (!created) throw new ConflictException("Failed to create effective-dated change.");

      await this.audit.log(
        {
          orgId,
          actorId,
          actorMembershipId,
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
        .set({ status: "approved", approvedByMembershipId: actorMembershipId, approvedAt: new Date() })
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
          actorMembershipId,
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
    const { cursor, employmentId, changeType, status } = input;
    const limit = boundHrReadLimit(input.limit);
    const cursorScope = {
      orgId,
      employmentId: employmentId ?? null,
      changeType: changeType ?? null,
      status: status ?? null,
    };
    const pos = decodeEffectiveChangeCursor(cursor, cursorScope);
    const conditions = [eq(hrEffectiveDatedChanges.orgId, orgId)];
    if (employmentId) conditions.push(eq(hrEffectiveDatedChanges.employmentId, employmentId));
    if (changeType) conditions.push(eq(hrEffectiveDatedChanges.changeType, changeType));
    if (status) conditions.push(eq(hrEffectiveDatedChanges.status, status));
    if (pos) conditions.push(keysetBeforeValue(hrEffectiveDatedChanges.effectiveFrom, hrEffectiveDatedChanges.id, pos));

    const rows = await this.db
      .select()
      .from(hrEffectiveDatedChanges)
      .where(and(...conditions))
      .orderBy(desc(hrEffectiveDatedChanges.effectiveFrom), desc(hrEffectiveDatedChanges.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: String(row.effectiveFrom),
      id: JSON.stringify([
        row.id,
        cursorScope.orgId,
        cursorScope.employmentId,
        cursorScope.changeType,
        cursorScope.status,
      ]),
    }));
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

      const actorMembershipId = await this.resolveActorMembershipId(tx, orgId, actorId);
      const [updated] = await tx
        .update(hrEffectiveDatedChanges)
        .set({ status: "approved", approvedByMembershipId: actorMembershipId, approvedAt: new Date() })
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
          actorMembershipId,
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
