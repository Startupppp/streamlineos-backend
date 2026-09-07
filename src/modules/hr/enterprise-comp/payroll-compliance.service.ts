import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  buildCursorPage,
  decodeCursor,
} from "../../../common/pagination/cursor";
import {
  keysetAfterValue,
  keysetBeforeId,
} from "../../../common/pagination/keyset";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrPayrollVarianceApprovals,
  hrArrearsAdjustments,
  hrPayrollComplianceTasks,
} from "../../../db/schema/hr/enterprise-comp";
import { HrAuditService } from "../core/hr-audit.service";
import type {
  CreateVarianceApprovalInput,
  ResolveVarianceInput,
  ListVarianceApprovalsInput,
  CreateArrearsInput,
  ListArrearsInput,
  CreateComplianceTaskInput,
  UpdateComplianceTaskInput,
  ListComplianceTasksInput,
} from "./dto/enterprise-comp.schemas";
import { hasPatchValues } from "../../../common/db/patch-values";

function decodePaginationCursor(cursor: string | undefined) {
  if (cursor === undefined) return null;
  const position = decodeCursor(cursor);
  if (!position) throw new BadRequestException("Invalid pagination cursor");
  return position;
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

const COUNTRY_PRESET_TASKS: Record<
  string,
  { name: string; dueDayOfMonth: number }[]
> = {
  IN: [
    { name: "PF Monthly Return (ECR)", dueDayOfMonth: 15 },
    { name: "ESI Monthly Contribution", dueDayOfMonth: 15 },
    { name: "TDS Deposition (Form 24Q)", dueDayOfMonth: 7 },
    { name: "Professional Tax", dueDayOfMonth: 10 },
  ],
  US: [
    { name: "Form 941 Quarterly Filing", dueDayOfMonth: 31 },
    { name: "Federal Payroll Tax Deposit", dueDayOfMonth: 15 },
    { name: "State Income Tax Withholding", dueDayOfMonth: 20 },
  ],
  GB: [
    { name: "PAYE RTI Submission", dueDayOfMonth: 19 },
    { name: "National Insurance Contributions", dueDayOfMonth: 19 },
    { name: "Auto-enrolment Pension Contributions", dueDayOfMonth: 22 },
  ],
};

@Injectable()
export class PayrollComplianceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async createVarianceApproval(
    orgId: string,
    actorId: string,
    input: CreateVarianceApprovalInput,
  ) {
    const [created] = await this.db
      .insert(hrPayrollVarianceApprovals)
      .values({
        orgId,
        payrollPeriodKey: input.payrollPeriodKey,
        variancePct: String(input.variancePct),
        thresholdPct: String(input.thresholdPct),
      })
      .returning();
    if (!created) throw new BadRequestException("Failed to create variance approval");
    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_payroll_variance_approvals",
      entityId: String(created.id),
      action: "created",
      after: created,
    });
    return created;
  }

  async listVarianceApprovals(
    orgId: string,
    input: ListVarianceApprovalsInput,
  ) {
    const { cursor, limit, status, payrollPeriodKey } = input;
    const conditions = [eq(hrPayrollVarianceApprovals.orgId, orgId)];
    if (status) conditions.push(eq(hrPayrollVarianceApprovals.status, status));
    if (payrollPeriodKey)
      conditions.push(
        eq(hrPayrollVarianceApprovals.payrollPeriodKey, payrollPeriodKey),
      );
    const position = decodePaginationCursor(cursor);
    if (position)
      conditions.push(
        keysetBeforeId(
          hrPayrollVarianceApprovals.createdAt,
          hrPayrollVarianceApprovals.id,
          position,
        ),
      );

    const rows = await this.db
      .select()
      .from(hrPayrollVarianceApprovals)
      .where(and(...conditions))
      .orderBy(
        desc(hrPayrollVarianceApprovals.createdAt),
        desc(hrPayrollVarianceApprovals.id),
      )
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (approval) => ({
      sortValue: approval.createdAt.toISOString(),
      id: String(approval.id),
    }));
  }

  async resolveVarianceApproval(
    orgId: string,
    id: number,
    actorId: string,
    input: ResolveVarianceInput,
  ) {
    const [existing] = await this.db
      .select()
      .from(hrPayrollVarianceApprovals)
      .where(
        and(
          eq(hrPayrollVarianceApprovals.id, id),
          eq(hrPayrollVarianceApprovals.orgId, orgId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("Variance approval not found");

    const [updated] = await this.db
      .update(hrPayrollVarianceApprovals)
      .set({
        status: input.action,
        approverId: actorId,
        note: input.note ?? null,
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(hrPayrollVarianceApprovals.id, id),
          eq(hrPayrollVarianceApprovals.orgId, orgId),
        ),
      )
      .returning();

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_payroll_variance_approvals",
      entityId: String(id),
      action: input.action,
      before: { status: existing.status },
      after: { status: input.action },
    });
    return updated;
  }

  async createArrears(
    orgId: string,
    actorId: string,
    input: CreateArrearsInput,
  ) {
    const [created] = await this.db
      .insert(hrArrearsAdjustments)
      .values({ orgId, ...input, createdBy: actorId })
      .returning();
    if (!created) throw new BadRequestException("Failed to create arrears adjustment");
    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_arrears_adjustments",
      entityId: String(created.id),
      action: "created",
      after: created,
    });
    return created;
  }

  async listArrears(orgId: string, input: ListArrearsInput) {
    const { cursor, limit, userId, status } = input;
    const conditions = [eq(hrArrearsAdjustments.orgId, orgId)];
    if (userId) conditions.push(eq(hrArrearsAdjustments.userId, userId));
    if (status) conditions.push(eq(hrArrearsAdjustments.status, status));
    const position = decodePaginationCursor(cursor);
    if (position)
      conditions.push(
        keysetBeforeId(
          hrArrearsAdjustments.createdAt,
          hrArrearsAdjustments.id,
          position,
        ),
      );

    const rows = await this.db
      .select()
      .from(hrArrearsAdjustments)
      .where(and(...conditions))
      .orderBy(
        desc(hrArrearsAdjustments.createdAt),
        desc(hrArrearsAdjustments.id),
      )
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (adjustment) => ({
      sortValue: adjustment.createdAt.toISOString(),
      id: String(adjustment.id),
    }));
  }

  async applyArrears(orgId: string, id: number, actorId: string) {
    const [existing] = await this.db
      .select()
      .from(hrArrearsAdjustments)
      .where(
        and(
          eq(hrArrearsAdjustments.id, id),
          eq(hrArrearsAdjustments.orgId, orgId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("Arrears adjustment not found");

    const [updated] = await this.db
      .update(hrArrearsAdjustments)
      .set({ status: "applied", appliedAt: new Date() })
      .where(
        and(
          eq(hrArrearsAdjustments.id, id),
          eq(hrArrearsAdjustments.orgId, orgId),
        ),
      )
      .returning();
    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_arrears_adjustments",
      entityId: String(id),
      action: "applied",
      before: { status: "pending" },
      after: { status: "applied" },
    });
    return updated;
  }

  async createComplianceTask(
    orgId: string,
    actorId: string,
    input: CreateComplianceTaskInput,
  ) {
    const [created] = await this.db
      .insert(hrPayrollComplianceTasks)
      .values({ orgId, ...input })
      .returning();
    if (!created) throw new BadRequestException("Failed to create compliance task");
    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_payroll_compliance_tasks",
      entityId: String(created.id),
      action: "created",
      after: created,
    });
    return created;
  }

  async listComplianceTasks(orgId: string, input: ListComplianceTasksInput) {
    const { cursor, limit, countryCode, status } = input;
    const conditions = [eq(hrPayrollComplianceTasks.orgId, orgId)];
    if (countryCode)
      conditions.push(eq(hrPayrollComplianceTasks.countryCode, countryCode));
    if (status) conditions.push(eq(hrPayrollComplianceTasks.status, status));
    const position = decodePaginationCursor(cursor);
    if (position) {
      if (!isDateOnly(position.sortValue))
        throw new BadRequestException("Invalid pagination cursor");
      conditions.push(
        keysetAfterValue(
          hrPayrollComplianceTasks.dueDate,
          hrPayrollComplianceTasks.id,
          position,
        ),
      );
    }

    const rows = await this.db
      .select()
      .from(hrPayrollComplianceTasks)
      .where(and(...conditions))
      .orderBy(
        asc(hrPayrollComplianceTasks.dueDate),
        asc(hrPayrollComplianceTasks.id),
      )
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (task) => ({
      sortValue: task.dueDate,
      id: String(task.id),
    }));
  }

  async updateComplianceTask(
    orgId: string,
    id: number,
    actorId: string,
    input: UpdateComplianceTaskInput,
  ) {
    const [existing] = await this.db
      .select()
      .from(hrPayrollComplianceTasks)
      .where(
        and(
          eq(hrPayrollComplianceTasks.id, id),
          eq(hrPayrollComplianceTasks.orgId, orgId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("Compliance task not found");

    const setData = {
      ...(input.countryCode !== undefined && { countryCode: input.countryCode }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.status === "completed" && { completedBy: actorId, completedAt: new Date() }),
    };
    if (!hasPatchValues(setData)) return existing;

    const [updated] = await this.db
      .update(hrPayrollComplianceTasks)
      .set(setData)
      .where(
        and(
          eq(hrPayrollComplianceTasks.id, id),
          eq(hrPayrollComplianceTasks.orgId, orgId),
        ),
      )
      .returning();
    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_payroll_compliance_tasks",
      entityId: String(id),
      action: "updated",
      before: existing,
      after: updated,
    });
    return updated;
  }

  async seedCountryPresets(
    orgId: string,
    actorId: string,
    countryCode: string,
    periodKey: string,
  ) {
    const presets = COUNTRY_PRESET_TASKS[countryCode.toUpperCase()];
    if (!presets)
      return { seeded: 0, message: `No presets for country ${countryCode}` };

    const [year, month] = periodKey.split("-");
    const upperCode = countryCode.toUpperCase();
    const presetNames = presets.map((p) => p.name);

    const existing = await this.db
      .select({ name: hrPayrollComplianceTasks.name })
      .from(hrPayrollComplianceTasks)
      .where(
        and(
          eq(hrPayrollComplianceTasks.orgId, orgId),
          eq(hrPayrollComplianceTasks.countryCode, upperCode),
          inArray(hrPayrollComplianceTasks.name, presetNames),
        ),
      )
      .limit(presetNames.length);

    const existingNames = new Set(existing.map((r) => r.name));
    const tasks = presets
      .filter((p) => !existingNames.has(p.name))
      .map((p) => ({
        orgId,
        countryCode: upperCode,
        name: p.name,
        dueDate: `${year}-${month}-${String(p.dueDayOfMonth).padStart(2, "0")}`,
      }));

    if (tasks.length === 0) return { seeded: 0 };

    const created = await this.db
      .insert(hrPayrollComplianceTasks)
      .values(tasks)
      .returning();
    return { seeded: created.length };
  }
}
