import { InternalServerErrorException } from "@nestjs/common";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  type SQL,
} from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import type { TenantTx } from "../../../../db/drizzle.types";
import { timesheets, timesheetExports } from "../../../../db/schema";
import { actingMembershipId } from "../../../../common/auth/principal";
import { TimesheetsAuditService } from "../timesheets-audit.service";
import {
  billingExportSnapshotSchema,
  type CreateInvoiceDraftInput,
  type ExportBillingInput,
} from "../dto/billing.schemas";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { round2 } from "./billing-money";

function csvCell(value: string | number): string {
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function billingSnapshotCsv(snapshot: PricedEntry[]): string {
  const header = ["Date", "ProjectId", "Hours", "BillRate", "Amount", "Currency", "Description"];
  const lines = [header.map(csvCell).join(",")];
  for (const row of snapshot) {
    lines.push(
      [
        row.date,
        row.projectId ?? "",
        row.hours,
        row.billRate ?? "",
        round2(row.computedAmount),
        row.currency ?? "",
        row.description ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

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

/**
 * Entries per round trip. Also what keeps the draft's flip legal: it binds one
 * parameter per id, and postgres-js refuses a statement at 65,534, so the
 * single whole-period `inArray` this replaced failed outright past ~65k
 * entries.
 */
export const BILLING_EXPORT_CHUNK = 1000;

const BILLABLE_ENTRY_COLUMNS = {
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
};

type BillableEntry = Pick<
  typeof timesheets.$inferSelect,
  keyof typeof BILLABLE_ENTRY_COLUMNS
>;
type PricedEntry = BillableEntry & { computedAmount: number };

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

  return deps.db.transaction(async (tx) => {
    const snapshot: PricedEntry[] = [];
    let totalHours = 0;
    let totalAmount = 0;

    for await (const chunk of billableEntryChunks(tx, conditions)) {
      for (const e of chunk) {
        const entry = priced(e);
        totalHours += parseFloat(e.hours);
        totalAmount += entry.computedAmount;
        snapshot.push(entry);
      }
    }

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
        entryCount: snapshot.length,
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
      after: { entryCount: snapshot.length, totalHours: round2(totalHours) },
    });

    return {
      exportId: exported.id,
      entryCount: snapshot.length,
      totalHours: round2(totalHours),
      totalAmount: round2(totalAmount),
      fileName: `billing-export_${input.startDate}_${input.endDate}.${input.format.toLowerCase()}`,
      csv: billingSnapshotCsv(snapshot),
    };
  });
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

  const parsedSnapshot = billingExportSnapshotSchema.safeParse(row.snapshot);
  const snapshotRows = parsedSnapshot.success ? parsedSnapshot.data : [];
  const totalAmount = round2(
    snapshotRows.reduce((sum, r) => sum + (r.computedAmount ?? 0), 0),
  );

  return {
    exportId: row.id,
    entryCount: row.entryCount,
    totalHours: parseFloat(row.totalHours),
    totalAmount,
    duplicate: true,
    csv: billingSnapshotCsv(snapshotRows as PricedEntry[]),
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

  return deps.db.transaction(async (tx) => {
    const snapshot: PricedEntry[] = [];
    let totalAmount = 0;

    for await (const chunk of billableEntryChunks(tx, conditions)) {
      await tx
        .update(timesheets)
        .set({ invoicingStatus: "INVOICE_DRAFTED", updatedAt: new Date() })
        .where(
          and(
            inArray(
              timesheets.id,
              chunk.map((e) => e.id),
            ),
            eq(timesheets.orgId, u.orgId),
          ),
        );
      for (const e of chunk) {
        const entry = priced(e);
        totalAmount += entry.computedAmount;
        snapshot.push(entry);
      }
    }

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
        entryCount: snapshot.length,
        totalHours: "0",
        createdByMembershipId: actorMembId,
      })
      .returning({ id: timesheetExports.id });

    if (!exported)
      throw new InternalServerErrorException(
        "Failed to create invoice draft",
      );

    await deps.audit.record(tx, {
      orgId: u.orgId,
      actorMembershipId: actorMembId,
      entityType: "billing",
      entityId: exported.id.toString(),
      action: "billing.invoice_drafted",
      after: { entryCount: snapshot.length, amount: round2(totalAmount) },
    });

    return {
      exportId: exported.id,
      entryCount: snapshot.length,
      amount: round2(totalAmount),
    };
  });
}

/**
 * Every entry `conditions` match, a keyset chunk at a time.
 *
 * Neither schema caps the span, so one request can cover an org's whole
 * history; this is what keeps that from being one result set. A LIMIT would be
 * the wrong bound — it would invoice a subset and report it as the whole — so
 * the loop reads on until a short chunk. Ordered by `timesheets.id` alone: one
 * strictly-increasing key visits every entry exactly once however the chunks
 * fall, and a period that is an exact multiple of the chunk costs one empty
 * read to discover.
 *
 * Takes the transaction, not the pool: the draft flips each chunk as it goes,
 * and a failure on a later chunk has to take those flips down with the export
 * row. It bounds the reads, not the snapshot — that is the export itself, one
 * JSONB array in one row, and it still grows with the period.
 */
async function* billableEntryChunks(
  tx: TenantTx,
  conditions: SQL[],
): AsyncGenerator<BillableEntry[]> {
  let afterId: number | undefined;
  for (;;) {
    const chunk = await tx
      .select(BILLABLE_ENTRY_COLUMNS)
      .from(timesheets)
      .where(
        and(
          ...conditions,
          afterId === undefined ? undefined : gt(timesheets.id, afterId),
        ),
      )
      .orderBy(asc(timesheets.id))
      .limit(BILLING_EXPORT_CHUNK);

    if (chunk.length > 0) yield chunk;
    const last = chunk[chunk.length - 1];
    if (!last || chunk.length < BILLING_EXPORT_CHUNK) return;
    afterId = last.id;
  }
}

function priced(e: BillableEntry): PricedEntry {
  const hours = parseFloat(e.hours);
  const rate = e.billRate ? parseFloat(e.billRate) : 0;
  return { ...e, computedAmount: round2(hours * rate) };
}
