import { NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { deals } from "../../../db/schema/crm/deals";
import {
  crmCommissionAccrualParts,
  crmCommissionAssignments,
  crmCommissionEarnings,
  crmCommissionPlanVersions,
} from "../../../db/schema/crm/commission";
import { periodWindow } from "../commission-rules";
import { summariseByRule } from "../commission-accrual";
import { earningsUserFilter } from "../commission-scope";
import type { AccrualQuery } from "../dto/commission-accrual.schemas";
import { utcToday } from "./accrual-ledger";
import { PERIOD_PART_PAGE, exactTotals, groupByDeal, toAccrualPart } from "./accrual-parts";

/**
 * The body of `CommissionAccrualService.periodAccrual`, whose docblock states
 * the contract. The viewer is narrowed here, before the first read, exactly as
 * it was in the method — this function is not a way around that scope.
 */
export async function readPeriodAccrual(
  db: Db,
  orgId: string,
  query: AccrualQuery,
  viewer: { userId: string; viewAll: boolean },
) {
  const userId = earningsUserFilter(query, viewer) ?? viewer.userId;
  const on = query.on ?? utcToday();

  return runInTenantTransaction(
    db,
    async (tx) => {
      const window = await resolvePeriod(tx, orgId, userId, query.planId, on);

      const periodPredicate = and(
        eq(crmCommissionAccrualParts.orgId, orgId),
        eq(crmCommissionAccrualParts.userId, userId),
        eq(crmCommissionAccrualParts.planId, window.planId),
        eq(crmCommissionAccrualParts.periodStart, window.start),
      );

      const page = await tx
        .select()
        .from(crmCommissionAccrualParts)
        .where(periodPredicate)
        .orderBy(
          asc(crmCommissionAccrualParts.earnedOn),
          asc(crmCommissionAccrualParts.earningId),
          asc(crmCommissionAccrualParts.partIndex),
        )
        // One past the page, which is how the overflow is *detected* rather
        // than assumed absent. Twenty bands per earning is already
        // extravagant, so the page is ~250 deals.
        .limit(PERIOD_PART_PAGE + 1);

      const truncated = page.length > PERIOD_PART_PAGE;
      const parts = truncated ? page.slice(0, PERIOD_PART_PAGE) : page;

      const dealNames = await readDealNames(tx, orgId, parts);
      const contributions = groupByDeal(parts, dealNames);
      const rules = summariseByRule(parts.map(toAccrualPart));

      // The headline is the whole period even when the itemisation is not, so
      // a truncated response is short of *explanations* and never short of
      // money. `reconciles` below then goes false on its own — the roll-ups
      // are over the page and the total is over the period — which is the
      // honest report: here is the figure, here is as much of it as fits, and
      // no, this page does not account for all of it.
      const totals = truncated
        ? await exactTotals(tx, periodPredicate)
        : {
            amountMinor: parts.reduce((sum, part) => sum + part.amountMinor, 0),
            basisMinor: parts.reduce((sum, part) => sum + part.basisMinor, 0),
            partCount: parts.length,
          };
      const { amountMinor, basisMinor } = totals;

      const [latest] = await tx
        .select({ attainmentBps: crmCommissionEarnings.attainmentBps })
        .from(crmCommissionEarnings)
        .where(
          and(
            eq(crmCommissionEarnings.orgId, orgId),
            eq(crmCommissionEarnings.userId, userId),
            eq(crmCommissionEarnings.planId, window.planId),
            eq(crmCommissionEarnings.periodStart, window.start),
            ne(crmCommissionEarnings.status, "VOID"),
          ),
        )
        .orderBy(
          desc(crmCommissionEarnings.earnedOn),
          desc(crmCommissionEarnings.createdAt),
        )
        .limit(1);

      return {
        userId,
        planId: window.planId,
        periodStart: window.start,
        periodEnd: window.end,
        period: window.period,
        asOf: on,
        amountMinor,
        basisMinor,
        currency: parts[0]?.currency ?? window.currency,
        attainmentBps: latest?.attainmentBps ?? null,
        dealCount: contributions.length,
        partCount: totals.partCount,
        itemisedPartCount: parts.length,
        /**
         * True means `deals` and `rules` are a page of the period rather than
         * the period. A client must not present the itemisation as complete
         * when this is set — narrow by plan or ask per deal instead.
         */
        truncated,
        deals: contributions,
        rules,
        /**
         * The acceptance test, asserted in the payload rather than described.
         * Both roll-ups are integer sums of the same rows as the headline, so
         * these can only be false if the itemisation was truncated, or if
         * something upstream persisted a decomposition that does not add up.
         */
        reconciles: {
          byDeal:
            contributions.reduce((sum, deal) => sum + deal.amountMinor, 0) ===
            amountMinor,
          byRule: rules.reduce((sum, rule) => sum + rule.amountMinor, 0) === amountMinor,
        },
      };
    },
    { orgId },
  );
}

/**
 * The attainment window governing `userId` on `on`, and the plan it belongs to.
 *
 * Resolved the same way `calculateForDeal` resolved it when the earnings were
 * written — assignment on the date, then version in force on the date, then
 * `periodWindow` — rather than inferred from whatever periods happen to appear
 * in the ledger. Inferring would report no period at all for a rep who has not
 * closed anything yet, and "you have earned nothing this month" is a different
 * and much more useful answer than "there is no month".
 */
async function resolvePeriod(
  tx: TenantTx,
  orgId: string,
  userId: string,
  planId: string | undefined,
  on: string,
) {
  const assignmentPredicates = [
    eq(crmCommissionAssignments.orgId, orgId),
    eq(crmCommissionAssignments.userId, userId),
    lte(crmCommissionAssignments.effectiveFrom, on),
    or(
      isNull(crmCommissionAssignments.effectiveTo),
      gte(crmCommissionAssignments.effectiveTo, on),
    ),
  ];
  if (planId) assignmentPredicates.push(eq(crmCommissionAssignments.planId, planId));

  const [assignment] = await tx
    .select()
    .from(crmCommissionAssignments)
    .where(and(...assignmentPredicates))
    .orderBy(desc(crmCommissionAssignments.effectiveFrom))
    .limit(1);

  if (!assignment)
    throw new NotFoundException(
      `No commission plan assignment was in force for this person on ${on}`,
    );

  const [version] = await tx
    .select()
    .from(crmCommissionPlanVersions)
    .where(
      and(
        eq(crmCommissionPlanVersions.orgId, orgId),
        eq(crmCommissionPlanVersions.planId, assignment.planId),
        lte(crmCommissionPlanVersions.effectiveFrom, on),
      ),
    )
    .orderBy(desc(crmCommissionPlanVersions.effectiveFrom))
    .limit(1);

  if (!version)
    throw new NotFoundException(
      `No version of this commission plan was in force on ${on}`,
    );

  const window = periodWindow(version.rules.period, on);
  return {
    planId: assignment.planId,
    period: version.rules.period,
    currency: "",
    ...window,
  };
}

/** Deal names for the parts in hand, in one query rather than per part. */
async function readDealNames(
  tx: TenantTx,
  orgId: string,
  parts: readonly { sourceType: string; sourceId: string }[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      parts
        .filter((part) => part.sourceType === "deal")
        .map((part) => Number(part.sourceId))
        .filter((id) => Number.isInteger(id)),
    ),
  ];
  if (ids.length === 0) return new Map();

  const rows = await tx
    .select({ id: deals.id, name: deals.name })
    .from(deals)
    .where(and(eq(deals.orgId, orgId), inArray(deals.id, ids)))
    .limit(1000);

  return new Map(rows.map((row) => [String(row.id), row.name]));
}
