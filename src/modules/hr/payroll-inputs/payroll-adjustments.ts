import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import type { Db } from "../../../db/drizzle.module";
import { hrPayrollAdjustments } from "../../../db/schema/payroll/input-capture";
import { users } from "../../../db/schema/common/auth";
import { HrAuditService } from "../core/hr-audit.service";
import type {
  CreateAdjustmentInput,
  SectionQueryInput,
} from "./dto/payroll-inputs.schemas";

export interface PayrollAdjustmentDeps {
  db: Db;
  audit: HrAuditService;
}

export async function listAdjustments(
  deps: PayrollAdjustmentDeps,
  orgId: string,
  periodId: number,
  input: SectionQueryInput,
) {
  const { cursor, limit } = input;
  const position = decodeCursor(cursor);
  if (cursor !== undefined && !position) {
    throw new BadRequestException("Invalid pagination cursor");
  }

  const conditions = [
    eq(hrPayrollAdjustments.orgId, orgId),
    eq(hrPayrollAdjustments.periodId, periodId),
  ];
  if (position) {
    conditions.push(
      keysetBeforeId(
        hrPayrollAdjustments.createdAt,
        hrPayrollAdjustments.id,
        position,
      ),
    );
  }

  const rows = await deps.db
    .select({
      id: hrPayrollAdjustments.id,
      userId: hrPayrollAdjustments.userId,
      adjustmentType: hrPayrollAdjustments.adjustmentType,
      section: hrPayrollAdjustments.section,
      amountCents: hrPayrollAdjustments.amountCents,
      days: hrPayrollAdjustments.days,
      reason: hrPayrollAdjustments.reason,
      status: hrPayrollAdjustments.status,
      createdAt: hrPayrollAdjustments.createdAt,
      userName: users.name,
      userFirstName: users.firstName,
      userLastName: users.lastName,
      userEmail: users.email,
    })
    .from(hrPayrollAdjustments)
    .innerJoin(users, eq(users.id, hrPayrollAdjustments.userId))
    .where(and(...conditions))
    .orderBy(desc(hrPayrollAdjustments.createdAt), desc(hrPayrollAdjustments.id))
    .limit(limit + 1);

  return buildCursorPage(rows, limit, (adjustment) => ({
    sortValue: adjustment.createdAt.toISOString(),
    id: String(adjustment.id),
  }));
}

export async function insertAdjustment(
  deps: PayrollAdjustmentDeps,
  orgId: string,
  actorId: string,
  input: CreateAdjustmentInput,
) {
  const [adj] = await deps.db
    .insert(hrPayrollAdjustments)
    .values({
      orgId,
      periodId: input.periodId ?? null,
      userId: input.userId,
      adjustmentType: input.adjustmentType,
      section: input.section,
      amountCents: input.amountCents ?? null,
      days: input.days ? String(input.days) : null,
      reason: input.reason,
      sourceChangeRef: input.sourceChangeRef ?? null,
      createdBy: actorId,
      status: "pending",
    })
    .returning();

  await deps.audit.log({
    orgId,
    actorId,
    entityType: "hr_payroll_adjustment",
    entityId: String(adj.id),
    action: "adjustment.created",
    after: input,
  });

  return adj;
}

export async function approveAdjustment(
  deps: PayrollAdjustmentDeps,
  orgId: string,
  actorId: string,
  adjustmentId: number,
) {
  await requirePendingAdjustment(deps, orgId, adjustmentId);

  const [updated] = await deps.db
    .update(hrPayrollAdjustments)
    .set({ status: "approved", approvedBy: actorId, approvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(hrPayrollAdjustments.id, adjustmentId), eq(hrPayrollAdjustments.orgId, orgId)))
    .returning();

  await deps.audit.log({
    orgId,
    actorId,
    entityType: "hr_payroll_adjustment",
    entityId: String(adjustmentId),
    action: "adjustment.approved",
    before: { status: "pending" },
    after: { status: "approved" },
  });

  return updated;
}

export async function rejectAdjustment(
  deps: PayrollAdjustmentDeps,
  orgId: string,
  actorId: string,
  adjustmentId: number,
  reason: string,
) {
  await requirePendingAdjustment(deps, orgId, adjustmentId);

  const [updated] = await deps.db
    .update(hrPayrollAdjustments)
    .set({
      status: "rejected",
      rejectedBy: actorId,
      rejectedAt: new Date(),
      rejectionReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(hrPayrollAdjustments.id, adjustmentId), eq(hrPayrollAdjustments.orgId, orgId)))
    .returning();

  await deps.audit.log({
    orgId,
    actorId,
    entityType: "hr_payroll_adjustment",
    entityId: String(adjustmentId),
    action: "adjustment.rejected",
    before: { status: "pending" },
    after: { status: "rejected", reason },
  });

  return updated;
}

async function requirePendingAdjustment(
  deps: PayrollAdjustmentDeps,
  orgId: string,
  adjustmentId: number,
) {
  const adj = await deps.db.query.hrPayrollAdjustments.findFirst({
    where: and(
      eq(hrPayrollAdjustments.id, adjustmentId),
      eq(hrPayrollAdjustments.orgId, orgId),
    ),
  });

  if (!adj) throw new NotFoundException("Adjustment not found");
  if (adj.status !== "pending") throw new BadRequestException("Adjustment is not in pending status");

  return adj;
}
