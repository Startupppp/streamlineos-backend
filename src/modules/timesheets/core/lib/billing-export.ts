import { InternalServerErrorException } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { timesheets, timesheetExports } from "../../../../db/schema";
import { actingMembershipId } from "../../../../common/auth/principal";
import { TimesheetsAuditService } from "../timesheets-audit.service";
import type { CreateInvoiceDraftInput, ExportBillingInput } from "../dto/billing.schemas";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { round2 } from "./billing-money";

/**
 * Marking billable time as invoiced.
 *
 * Split from the reads beside it because these are the only writes on this
 * service and they are one-way: an export stamps `timesheet_exports` and flips
 * the entries it covered, and nothing in this module un-flips them. That is
 * also why both entry points are idempotent on a caller-supplied key and why
 * `findExportByIdempotencyKey` sits here rather than with the queries — it
 * exists only to make the retry of a write safe, which is a property of the
 * write, not a way of reading exports.
 *
 * The reads that stayed (`getUninvoiced`, `getRatePreview`,
 * `getBillableWorkForNarrative`) answer "what would this cost" and can be
 * called all day with no effect.
 */
export interface BillingExportDeps {
  readonly db: Db;
  readonly audit: TimesheetsAuditService;
}

export async function exportBilling(
  deps: BillingExportDeps,
  u: CurrentUserContext,
  input: ExportBillingInput,
) {
  if (input.idempotencyKey) {
    const existing = await findExportByIdempotencyKey(
    deps,
      u.orgId,
      input.idempotencyKey,
    );
    if (existing) return existing;
  }

  const conditions = [
    eq(timesheets.orgId, u.orgId),
    eq(timesheets.status, "APPROVED"),
    eq(timesheets.isBillable, true),
    isNull(timesheets.voidedAt),
    gte(timesheets.date, input.startDate),
    lte(timesheets.date, input.endDate),
  ];

  if (input.projectId)
    conditions.push(eq(timesheets.projectId, input.projectId));

  const entries = await deps.db
    .select({
      id: timesheets.id,
      orgId: timesheets.orgId,
      projectId: timesheets.projectId,
      ticketId: timesheets.ticketId,
      date: timesheets.date,
      hours: timesheets.hours,
      description: timesheets.description,
      isBillable: timesheets.isBillable,
      billRate: timesheets.billRate,
      currency: timesheets.currency,
      invoicingStatus: timesheets.invoicingStatus,
      status: timesheets.status,
    })
    .from(timesheets)
    .where(and(...conditions));

  let totalHours = 0;
  let totalAmount = 0;

  const snapshot = entries.map((e) => {
    const hours = parseFloat(e.hours);
    const rate = e.billRate ? parseFloat(e.billRate) : 0;
    const amount = round2(hours * rate);
    totalHours += hours;
    totalAmount += amount;
    return { ...e, computedAmount: amount };
  });

  const exportId = await deps.db.transaction(async (tx) => {
    const actorMembId = actingMembershipId(u.principal);

    const [exported] = await tx
      .insert(timesheetExports)
      .values({
        orgId: u.orgId,
        exportType: "BILLING",
        status: "COMPLETED",
        dateRangeStart: input.startDate,
        dateRangeEnd: input.endDate,
        format: input.format,
        filters: { projectId: input.projectId ?? null },
        snapshot: snapshot,
        entryCount: entries.length,
        totalHours: round2(totalHours).toString(),
        createdByMembershipId: actorMembId,
      })
      .returning({ id: timesheetExports.id });

    if (!exported)
      throw new InternalServerErrorException(
        "Failed to create billing export",
      );

    await deps.audit.record(tx, {
      orgId: u.orgId,
      actorMembershipId: actorMembId,
      entityType: "billing",
      entityId: exported.id.toString(),
      action: "billing.exported",
      after: { entryCount: entries.length, totalHours: round2(totalHours) },
    });

    return exported.id;
  });

  return {
    exportId,
    entryCount: entries.length,
    totalHours: round2(totalHours),
    totalAmount: round2(totalAmount),
  };
}

async function findExportByIdempotencyKey(
  deps: BillingExportDeps,
  orgId: string,
  idempotencyKey: string,
) {
  const [row] = await deps.db
    .select({
      id: timesheetExports.id,
      entryCount: timesheetExports.entryCount,
      totalHours: timesheetExports.totalHours,
      snapshot: timesheetExports.snapshot,
    })
    .from(timesheetExports)
    .where(
      and(
        eq(timesheetExports.orgId, orgId),
        eq(timesheetExports.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);

  if (!row) return null;

  const snapshotRows =
    (row.snapshot as { computedAmount?: number }[] | null) ?? [];
  const totalAmount = round2(
    snapshotRows.reduce((sum, r) => sum + (r.computedAmount ?? 0), 0),
  );

  return {
    exportId: row.id,
    entryCount: row.entryCount,
    totalHours: parseFloat(row.totalHours),
    totalAmount,
    duplicate: true,
  };
}

export async function createInvoiceDraft(
  deps: BillingExportDeps,
  u: CurrentUserContext,
  input: CreateInvoiceDraftInput,
) {
  const conditions = [
    eq(timesheets.orgId, u.orgId),
    eq(timesheets.status, "APPROVED"),
    eq(timesheets.isBillable, true),
    isNull(timesheets.voidedAt),
    eq(timesheets.invoicingStatus, "UNINVOICED"),
    gte(timesheets.date, input.startDate),
    lte(timesheets.date, input.endDate),
  ];

  if (input.projectId)
    conditions.push(eq(timesheets.projectId, input.projectId));

  const entries = await deps.db
    .select({
      id: timesheets.id,
      orgId: timesheets.orgId,
      projectId: timesheets.projectId,
      ticketId: timesheets.ticketId,
      date: timesheets.date,
      hours: timesheets.hours,
      description: timesheets.description,
      isBillable: timesheets.isBillable,
      billRate: timesheets.billRate,
      currency: timesheets.currency,
      invoicingStatus: timesheets.invoicingStatus,
      status: timesheets.status,
    })
    .from(timesheets)
    .where(and(...conditions));

  let totalAmount = 0;
  const snapshot = entries.map((e) => {
    const hours = parseFloat(e.hours);
    const rate = e.billRate ? parseFloat(e.billRate) : 0;
    const amount = round2(hours * rate);
    totalAmount += amount;
    return { ...e, computedAmount: amount };
  });

  const entryIds = entries.map((e) => e.id);

  const exportId = await deps.db.transaction(async (tx) => {
    const actorMembId = actingMembershipId(u.principal);

    const [exported] = await tx
      .insert(timesheetExports)
      .values({
        orgId: u.orgId,
        exportType: "INVOICE_DRAFT",
        status: "COMPLETED",
        dateRangeStart: input.startDate,
        dateRangeEnd: input.endDate,
        format: "JSON",
        filters: { projectId: input.projectId ?? null },
        snapshot: snapshot,
        entryCount: entries.length,
        totalHours: "0",
        createdByMembershipId: actorMembId,
      })
      .returning({ id: timesheetExports.id });

    if (!exported)
      throw new InternalServerErrorException(
        "Failed to create invoice draft",
      );

    if (entryIds.length > 0) {
      await tx
        .update(timesheets)
        .set({ invoicingStatus: "INVOICE_DRAFTED", updatedAt: new Date() })
        .where(
          and(
            inArray(timesheets.id, entryIds),
            eq(timesheets.orgId, u.orgId),
          ),
        );
    }

    await deps.audit.record(tx, {
      orgId: u.orgId,
      actorMembershipId: actorMembId,
      entityType: "billing",
      entityId: exported.id.toString(),
      action: "billing.invoice_drafted",
      after: { entryCount: entries.length, amount: round2(totalAmount) },
    });

    return exported.id;
  });

  return {
    exportId,
    entryCount: entries.length,
    amount: round2(totalAmount),
  };
}
