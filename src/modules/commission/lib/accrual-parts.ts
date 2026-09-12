import { and, sql } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import { crmCommissionAccrualParts } from "../../../db/schema/crm/commission";
import { summariseByRule, type AccrualPart, type RuleContribution } from "../commission-accrual";

/**
 * Stored accrual part rows, and the shapes a response itemises them into.
 *
 * Shared by the reads in `accrual-period.ts` and `accrual-reads.ts`, and by the
 * ledger writer in `accrual-ledger.ts` for `toMinor`. Every total here is
 * integer addition over the rows a response also lists — the property
 * `CommissionAccrualService`'s docblock states.
 */

/** A `sum()` over `bigint` arrives as `numeric`, i.e. a string. Never a float. */
export function toMinor(value: string | number | null | undefined): number {
  return Number(value ?? 0);
}

/**
 * How many part rows one response will itemise.
 *
 * Both reads are bounded, because a rep with a thousand deals in a period would
 * otherwise stream an unbounded result into a JSON body. The bound is the reason
 * `truncated` exists: see `exactTotals`.
 */
export const PERIOD_PART_PAGE = 5_000;
export const DEAL_PART_PAGE = 500;

/**
 * The exact totals over *every* part matching a predicate, ignoring the page.
 *
 * Only called when the page overflowed, and that restraint is the point. When
 * the page holds every row, summing the rows in hand is the same number and
 * computing it a second way in SQL would create a second authority that could
 * one day disagree with the first.
 *
 * When the page did *not* hold every row, summing the rows in hand is a wrong
 * number, and wrong in the direction that matters: it understates what somebody
 * is owed, silently, with a `reconciles: true` beside it because the truncated
 * parts agree perfectly with their own truncated total. That is the specific
 * failure this function prevents — a headline that is short by however many
 * deals fell off the end, wearing a proof that it adds up.
 */
export async function exactTotals(
  // Either a tenant transaction or the pooled handle: the reads that need this
  // are split across both, and widening to the one method used is cheaper than
  // making `byDeal` open a transaction it has no other reason to want.
  tx: Pick<TenantTx, "select"> | Pick<Db, "select">,
  predicate: ReturnType<typeof and>,
): Promise<{ amountMinor: number; basisMinor: number; partCount: number }> {
  const [totals] = await tx
    .select({
      accrued: sql<string>`coalesce(sum(${crmCommissionAccrualParts.amountMinor}), 0)`,
      basis: sql<string>`coalesce(sum(${crmCommissionAccrualParts.basisMinor}), 0)`,
      parts: sql<string>`count(*)`,
    })
    .from(crmCommissionAccrualParts)
    .where(predicate);

  return {
    amountMinor: toMinor(totals?.accrued),
    basisMinor: toMinor(totals?.basis),
    partCount: Number(totals?.parts ?? 0),
  };
}

/** One deal's contribution to an accrual, and the rules behind it. */
export interface DealContribution {
  sourceType: string;
  sourceId: string;
  dealName: string | null;
  earningId: string;
  planId: string;
  planVersionId: string;
  earnedOn: string;
  basisMinor: number;
  amountMinor: number;
  rules: RuleContribution[];
}

/**
 * Parts to per-deal contributions, preserving the exact totals.
 *
 * Integer addition only; nothing is rounded or re-derived, which is why the
 * grouped totals sum back to the ungrouped one.
 */
export function groupByDeal(
  parts: readonly (typeof crmCommissionAccrualParts.$inferSelect)[],
  dealNames: Map<string, string>,
): DealContribution[] {
  const byEarning = new Map<string, { row: DealContribution; parts: AccrualPart[] }>();

  for (const part of parts) {
    const existing = byEarning.get(part.earningId);
    if (existing) {
      existing.row.amountMinor += part.amountMinor;
      existing.row.basisMinor += part.basisMinor;
      existing.parts.push(toAccrualPart(part));
      continue;
    }
    byEarning.set(part.earningId, {
      row: {
        sourceType: part.sourceType,
        sourceId: part.sourceId,
        dealName: dealNames.get(part.sourceId) ?? null,
        earningId: part.earningId,
        planId: part.planId,
        planVersionId: part.planVersionId,
        earnedOn: part.earnedOn,
        basisMinor: part.basisMinor,
        amountMinor: part.amountMinor,
        rules: [],
      },
      parts: [toAccrualPart(part)],
    });
  }

  return [...byEarning.values()].map(({ row, parts: own }) => ({
    ...row,
    rules: summariseByRule(own),
  }));
}

/** A stored part row as the pure module's `AccrualPart`. */
export function toAccrualPart(row: typeof crmCommissionAccrualParts.$inferSelect): AccrualPart {
  return {
    partIndex: row.partIndex,
    tierIndex: row.tierIndex,
    tierFrom: row.tierFrom,
    rateBps: row.rateBps,
    multiplierBps: row.multiplierBps,
    fromMinor: row.sliceFromMinor,
    toMinor: row.sliceToMinor,
    basisMinor: row.basisMinor,
    amountMinor: row.amountMinor,
  };
}
