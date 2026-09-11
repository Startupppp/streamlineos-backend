import { NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import {
  crmCommissionAccrualParts,
  crmCommissionAccrualSnapshots,
  crmCommissionEarnings,
} from "../../../db/schema/crm/commission";
import { summariseByRule } from "../commission-accrual";
import { earningsUserFilter } from "../commission-scope";
import type { AccrualCurveQuery } from "../dto/commission-accrual.schemas";
import { DEAL_PART_PAGE, exactTotals, toAccrualPart } from "./accrual-parts";

/**
 * The narrow reads of an accrual: one earning, one deal, one earner's curve.
 *
 * Each is the body of the `CommissionAccrualService` method named on it, whose
 * docblock states the contract. Each narrows by the viewer itself, so importing
 * one is not a way to read a colleague's pay without the scope.
 */

/** The body of `CommissionAccrualService.decomposeEarning`. */
export async function readEarningDecomposition(
  db: Db,
  orgId: string,
  earningId: string,
  viewer: { userId: string; viewAll: boolean },
) {
  const [earning] = await db
    .select()
    .from(crmCommissionEarnings)
    .where(
      and(
        eq(crmCommissionEarnings.orgId, orgId),
        eq(crmCommissionEarnings.earningId, earningId),
      ),
    )
    .limit(1);

  // Not found and not-yours are the same answer on purpose: distinguishing
  // them turns this route into an oracle for whether a colleague has an
  // earning, which is the compensation leak the scope exists to close.
  if (!earning || (!viewer.viewAll && earning.userId !== viewer.userId))
    throw new NotFoundException("Commission earning not found");

  const parts = await db
    .select()
    .from(crmCommissionAccrualParts)
    .where(
      and(
        eq(crmCommissionAccrualParts.orgId, orgId),
        eq(crmCommissionAccrualParts.earningId, earningId),
      ),
    )
    .orderBy(asc(crmCommissionAccrualParts.partIndex))
    .limit(200);

  const amountMinor = parts.reduce((sum, part) => sum + part.amountMinor, 0);

  return {
    earning,
    parts,
    rules: summariseByRule(parts.map(toAccrualPart)),
    /**
     * False means this earning predates its decomposition or had one written
     * around `recordAccrualForEarning`; `POST /rebuild` is the repair. Stated
     * rather than thrown, because a caller asking to see the derivation of a
     * broken row should get the row and the fact that it is broken.
     */
    reconciles: parts.length > 0 && amountMinor === earning.amountMinor,
    decomposedMinor: amountMinor,
  };
}

/** The body of `CommissionAccrualService.byDeal`. */
export async function readDealAccrual(
  db: Db,
  orgId: string,
  dealId: number,
  viewer: { userId: string; viewAll: boolean },
) {
  const predicates = [
    eq(crmCommissionAccrualParts.orgId, orgId),
    eq(crmCommissionAccrualParts.sourceType, "deal"),
    eq(crmCommissionAccrualParts.sourceId, String(dealId)),
  ];
  if (!viewer.viewAll)
    predicates.push(eq(crmCommissionAccrualParts.userId, viewer.userId));

  const predicate = and(...predicates);

  const page = await db
    .select()
    .from(crmCommissionAccrualParts)
    .where(predicate)
    .orderBy(
      asc(crmCommissionAccrualParts.userId),
      asc(crmCommissionAccrualParts.partIndex),
    )
    .limit(DEAL_PART_PAGE + 1);

  const truncated = page.length > DEAL_PART_PAGE;
  const parts = truncated ? page.slice(0, DEAL_PART_PAGE) : page;

  // Same rule as the period read: the deal's total is the deal's total. A
  // split across enough people to overflow the page is pathological, but "we
  // showed you a smaller number because the list was long" is not a failure
  // mode worth leaving open on a compensation figure.
  const totals = truncated
    ? await exactTotals(db, predicate)
    : {
        amountMinor: parts.reduce((sum, part) => sum + part.amountMinor, 0),
        basisMinor: parts.reduce((sum, part) => sum + part.basisMinor, 0),
        partCount: parts.length,
      };

  return {
    sourceType: "deal",
    sourceId: String(dealId),
    amountMinor: totals.amountMinor,
    basisMinor: totals.basisMinor,
    partCount: totals.partCount,
    truncated,
    parts,
    rules: summariseByRule(parts.map(toAccrualPart)),
    /** The parts listed account for the whole figure. False when truncated. */
    reconciles:
      parts.reduce((sum, part) => sum + part.amountMinor, 0) === totals.amountMinor,
  };
}

/** The body of `CommissionAccrualService.curve`. */
export async function readAccrualCurve(
  db: Db,
  orgId: string,
  query: AccrualCurveQuery,
  viewer: { userId: string; viewAll: boolean },
) {
  const userId = earningsUserFilter(query, viewer) ?? viewer.userId;

  const predicates = [
    eq(crmCommissionAccrualSnapshots.orgId, orgId),
    eq(crmCommissionAccrualSnapshots.userId, userId),
  ];
  if (query.planId)
    predicates.push(eq(crmCommissionAccrualSnapshots.planId, query.planId));
  if (query.from) predicates.push(gte(crmCommissionAccrualSnapshots.asOfDate, query.from));
  if (query.to) predicates.push(lte(crmCommissionAccrualSnapshots.asOfDate, query.to));

  const points = await db
    .select()
    .from(crmCommissionAccrualSnapshots)
    .where(and(...predicates))
    .orderBy(asc(crmCommissionAccrualSnapshots.asOfDate))
    .limit(query.limit);

  return { userId, points };
}
