import { and, eq, lte, sql } from "drizzle-orm";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import {
  crmCommissionAccrualParts,
  crmCommissionAccrualSnapshots,
} from "../../../db/schema/crm/commission";
import { accrualPartRows, assertPartsSumTo, type AccrualPart } from "../commission-accrual";
import { toMinor } from "./accrual-parts";

/**
 * The write half of the accrual ledger: one earning's decomposition, and the
 * day's curve point it moves. `commission-accrual.service.ts` re-exports the
 * public names, so they keep the path they have always been imported from.
 */

/** Today, UTC, as the ISO date the `date` columns hold. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The day a curve point is filed under.
 *
 * Clamped into the period it belongs to. A calculation run after the period
 * closed — a late deal, a rebuild — would otherwise file a point outside
 * `[period_start, period_end]`, and the curve for March would carry a point in
 * June that no month-end review would ever look at. Clamping files it as the
 * last day of the period it actually moved, which is the day whose figure
 * changed.
 */
export function snapshotDate(
  today: string,
  window: { start: string; end: string },
): string {
  if (today < window.start) return window.start;
  if (today > window.end) return window.end;
  return today;
}

/**
 * Rewrite one earning's decomposition, and refresh the day's curve point.
 *
 * A free function taking a transaction rather than a method, so that
 * `CommissionService.calculateForDeal` can call it inside the same transaction
 * as the INSERT that created the earning without `CommissionService` having to
 * depend on this class. Accrual that lands in a second transaction is accrual
 * that can be missing: the request that timed out between the two would leave an
 * earning nobody's accrual counted, and the figure people watch would quietly
 * understate what they are owed.
 *
 * Delete-then-insert rather than upsert-by-index. A rebuild of an earning whose
 * decomposition now has fewer parts must not leave the surplus rows behind — they
 * would still sum into every period total, and the reconciliation trigger would
 * reject the commit with a message about an earning nobody had touched.
 */
export async function recordAccrualForEarning(
  tx: TenantTx,
  input: {
    orgId: string;
    earningId: string;
    userId: string;
    planId: string;
    planVersionId: string;
    earnedOn: string;
    periodStart: string;
    periodEnd: string;
    sourceType: string;
    sourceId: string;
    currency: string;
    amountMinor: number;
    attainmentBps: number | null;
    parts: AccrualPart[];
  },
  today: string = utcToday(),
): Promise<{ partCount: number }> {
  // Restated at the boundary rather than trusted from the caller: parts and
  // total reach the database as separate columns of separate tables, and a
  // decomposition that does not add up looks entirely normal until totalled.
  assertPartsSumTo(input.amountMinor, input.parts);

  await tx
    .delete(crmCommissionAccrualParts)
    .where(
      and(
        eq(crmCommissionAccrualParts.orgId, input.orgId),
        eq(crmCommissionAccrualParts.earningId, input.earningId),
      ),
    );

  if (input.parts.length > 0)
    await tx.insert(crmCommissionAccrualParts).values(accrualPartRows(input, input.parts));

  await refreshSnapshot(tx, {
    orgId: input.orgId,
    userId: input.userId,
    planId: input.planId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    currency: input.currency,
    attainmentBps: input.attainmentBps,
    asOfDate: snapshotDate(today, { start: input.periodStart, end: input.periodEnd }),
  });

  return { partCount: input.parts.length };
}

/**
 * Recompute today's curve point for one earner, plan and period.
 *
 * Reads the parts back rather than adding a delta to the previous point. A delta
 * is right until an earning is rebuilt or voided, at which point the curve
 * carries an error forward for the rest of the period with nothing to reveal it.
 * The read is one indexed aggregate over a single period's rows.
 */
async function refreshSnapshot(
  tx: TenantTx,
  input: {
    orgId: string;
    userId: string;
    planId: string;
    periodStart: string;
    periodEnd: string;
    currency: string;
    attainmentBps: number | null;
    asOfDate: string;
  },
): Promise<void> {
  const [totals] = await tx
    .select({
      accrued: sql<string>`coalesce(sum(${crmCommissionAccrualParts.amountMinor}), 0)`,
      basis: sql<string>`coalesce(sum(${crmCommissionAccrualParts.basisMinor}), 0)`,
      parts: sql<string>`count(*)`,
      earnings: sql<string>`count(distinct ${crmCommissionAccrualParts.earningId})`,
    })
    .from(crmCommissionAccrualParts)
    .where(
      and(
        eq(crmCommissionAccrualParts.orgId, input.orgId),
        eq(crmCommissionAccrualParts.userId, input.userId),
        eq(crmCommissionAccrualParts.planId, input.planId),
        eq(crmCommissionAccrualParts.periodStart, input.periodStart),
        lte(crmCommissionAccrualParts.earnedOn, input.asOfDate),
      ),
    );

  await tx
    .insert(crmCommissionAccrualSnapshots)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      planId: input.planId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      asOfDate: input.asOfDate,
      accruedMinor: toMinor(totals?.accrued),
      basisMinor: toMinor(totals?.basis),
      partCount: Number(totals?.parts ?? 0),
      earningCount: Number(totals?.earnings ?? 0),
      attainmentBps: input.attainmentBps,
      currency: input.currency,
    })
    .onConflictDoUpdate({
      target: [
        crmCommissionAccrualSnapshots.orgId,
        crmCommissionAccrualSnapshots.userId,
        crmCommissionAccrualSnapshots.planId,
        crmCommissionAccrualSnapshots.periodStart,
        crmCommissionAccrualSnapshots.asOfDate,
      ],
      set: {
        accruedMinor: toMinor(totals?.accrued),
        basisMinor: toMinor(totals?.basis),
        partCount: Number(totals?.parts ?? 0),
        earningCount: Number(totals?.earnings ?? 0),
        attainmentBps: input.attainmentBps,
        computedAt: new Date(),
      },
    });
}
