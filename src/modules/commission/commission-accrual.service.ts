import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../common/tenant/with-tenant";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { deals } from "../../db/schema/crm/deals";
import {
  crmCommissionAccrualParts,
  crmCommissionAccrualSnapshots,
  crmCommissionAssignments,
  crmCommissionEarnings,
  crmCommissionPlanVersions,
} from "../../db/schema/crm/commission";
import { evaluateCommission, periodWindow } from "./commission-rules";
import {
  accrualPartRows,
  assertPartsSumTo,
  decomposeEvaluation,
  summariseByRule,
  type AccrualPart,
  type RuleContribution,
} from "./commission-accrual";
import { earningsUserFilter } from "./commission.service";
import type {
  AccrualCurveQuery,
  AccrualQuery,
  RebuildAccrualInput,
} from "./dto/commission-accrual.schemas";

/**
 * Reading an accrual, and keeping the ledger that makes it decomposable.
 *
 * The ticket's acceptance test is a single property: **any accrued figure this
 * service returns is the exact integer sum of the parts it returns alongside
 * it.** Not approximately, not modulo rounding — exactly, because these are
 * minor units and a residue of one is a residue.
 *
 * That property is bought by never computing a total two ways. Every figure
 * here — a period accrual, a per-deal contribution, a per-rule roll-up, a
 * curve point — is a `sum()` over the same `crm_commission_accrual_parts` rows
 * the response also itemises. There is no path where a headline number is
 * derived from the earnings table and its breakdown from the parts table; that
 * arrangement is how two figures that must agree stop agreeing, and it is what
 * `computation` jsonb on the earning would have forced.
 *
 * The parts themselves are apportioned from the earning's settled total by
 * `decomposeEvaluation`, so the chain closes: parts sum to the earning, earnings
 * sum to the period, and the period is what the curve records.
 *
 * Money is integer minor units on every path. `sum()` over a `bigint` column is
 * `numeric`, which postgres-js returns as a string; every such read is converted
 * deliberately below and never by coincidence.
 */

/** A `sum()` over `bigint` arrives as `numeric`, i.e. a string. Never a float. */
function toMinor(value: string | number | null | undefined): number {
  return Number(value ?? 0);
}

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

/**
 * How many part rows one response will itemise.
 *
 * Both reads are bounded, because a rep with a thousand deals in a period would
 * otherwise stream an unbounded result into a JSON body. The bound is the reason
 * `truncated` exists: see `exactTotals`.
 */
const PERIOD_PART_PAGE = 5_000;
const DEAL_PART_PAGE = 500;

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
async function exactTotals(
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

@Injectable()
export class CommissionAccrualService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The accrued figure for a period, and everything that produced it.
   *
   * The response's `amountMinor` is a `sum()` over exactly the part rows that
   * `deals` and `rules` itemise, so the three agree by construction rather than
   * by care. `reconciles` states that in the payload: a client that shows a
   * total beside a breakdown can assert it rather than trusting this docblock.
   *
   * The single exception is a period too large to itemise in one response, and
   * it is reported rather than hidden: `amountMinor` still covers the whole
   * period, `truncated` is true, and `reconciles` is consequently false. The
   * alternative — letting the page's own total stand as the headline — would
   * have shipped an understated figure carrying a proof that it added up.
   */
  async periodAccrual(
    orgId: string,
    query: AccrualQuery,
    viewer: { userId: string; viewAll: boolean },
  ) {
    const userId = earningsUserFilter(query, viewer) ?? viewer.userId;
    const on = query.on ?? utcToday();

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const window = await this.resolvePeriod(tx, orgId, userId, query.planId, on);

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

        const dealNames = await this.dealNames(tx, orgId, parts);
        const contributions = this.groupByDeal(parts, dealNames);
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
   * One earning, taken apart.
   *
   * The narrow end of the same telescope: the period view answers "where did
   * this month's number come from", this answers "and where did that deal's
   * share come from". `reconciles` is the same claim at earning granularity.
   */
  async decomposeEarning(
    orgId: string,
    earningId: string,
    viewer: { userId: string; viewAll: boolean },
  ) {
    const [earning] = await this.db
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

    const parts = await this.db
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

  /**
   * What one deal paid, to whom, under which rule.
   *
   * The dispute's opening question, answered from an index rather than by
   * scanning a period. Narrowed by the caller's scope like every other read
   * here: a rep may see their own share of a deal, not their colleague's.
   */
  async byDeal(
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

    const page = await this.db
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
      ? await exactTotals(this.db, predicate)
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

  /**
   * The curve: what the accrued figure stood at on each day of the period.
   *
   * This is the "people have been watching it" half of the ticket. Served from
   * the stored snapshots rather than recomputed from the parts, so a point
   * cannot be revised after the fact by a late deal — see the table's docblock.
   */
  async curve(
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

    const points = await this.db
      .select()
      .from(crmCommissionAccrualSnapshots)
      .where(and(...predicates))
      .orderBy(asc(crmCommissionAccrualSnapshots.asOfDate))
      .limit(query.limit);

    return { userId, points };
  }

  /**
   * Re-derive the decomposition of a bounded set of earnings.
   *
   * Two jobs, and neither is restatement. It supplies parts for earnings written
   * before this ticket shipped, and it repairs a decomposition that a partial
   * failure left inconsistent.
   *
   * What it cannot do is change what anybody is paid: it re-evaluates from the
   * plan version and inputs already stored on the earning row and apportions the
   * **stored** `amount_minor`, so a rule set that somehow changed underneath
   * would move the split between bands and not the total. Any earning whose
   * stored total no longer matches a fresh evaluation is reported as `drifted`
   * and skipped rather than quietly reconciled — a payout that has moved is a
   * conversation, not a repair.
   */
  async rebuild(orgId: string, input: RebuildAccrualInput) {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const predicates = [
          eq(crmCommissionEarnings.orgId, orgId),
          gte(crmCommissionEarnings.earnedOn, input.from),
          lte(crmCommissionEarnings.earnedOn, input.to),
          ne(crmCommissionEarnings.status, "VOID"),
        ];
        if (input.userId) predicates.push(eq(crmCommissionEarnings.userId, input.userId));
        if (input.planId) predicates.push(eq(crmCommissionEarnings.planId, input.planId));

        const earnings = await tx
          .select()
          .from(crmCommissionEarnings)
          .where(and(...predicates))
          .orderBy(asc(crmCommissionEarnings.earnedOn), asc(crmCommissionEarnings.createdAt))
          .limit(input.limit);

        const versionIds = [...new Set(earnings.map((e) => e.planVersionId))];
        const versions = versionIds.length
          ? await tx
              .select()
              .from(crmCommissionPlanVersions)
              .where(
                and(
                  eq(crmCommissionPlanVersions.orgId, orgId),
                  inArray(crmCommissionPlanVersions.planVersionId, versionIds),
                ),
              )
          : [];
        const rulesByVersion = new Map(versions.map((v) => [v.planVersionId, v.rules]));

        const today = utcToday();
        let rebuilt = 0;
        let partsWritten = 0;
        const drifted: string[] = [];
        const skipped: string[] = [];

        for (const earning of earnings) {
          const rules = rulesByVersion.get(earning.planVersionId);
          if (!rules) {
            skipped.push(earning.earningId);
            continue;
          }

          const evaluation = evaluateCommission(rules, {
            basisMinor: earning.basisMinor,
            priorBasisMinor: earning.priorBasisMinor,
            // The quota that actually applied, read off the row rather than off
            // today's assignment: an assignment can have been re-dated or ended
            // since, and re-reading it would re-base a historical split against
            // a quota that was not in force when the money was earned.
            quotaOverrideMinor: readQuotaMinor(earning.computation),
          });

          if (evaluation.amountMinor !== earning.amountMinor) {
            drifted.push(earning.earningId);
            continue;
          }

          const { partCount } = await recordAccrualForEarning(
            tx,
            {
              orgId,
              earningId: earning.earningId,
              userId: earning.userId,
              planId: earning.planId,
              planVersionId: earning.planVersionId,
              earnedOn: earning.earnedOn,
              periodStart: earning.periodStart,
              periodEnd: earning.periodEnd,
              sourceType: earning.sourceType,
              sourceId: earning.sourceId,
              currency: earning.currency,
              amountMinor: earning.amountMinor,
              attainmentBps: earning.attainmentBps,
              parts: decomposeEvaluation(evaluation),
            },
            today,
          );

          rebuilt += 1;
          partsWritten += partCount;
        }

        return {
          examined: earnings.length,
          rebuilt,
          partsWritten,
          /** Stored total and fresh evaluation disagree; needs a human. */
          drifted,
          /** Plan version unreadable — nothing safe to do without its rules. */
          skipped,
        };
      },
      { orgId },
    );
  }

  // ── Internals ────────────────────────────────────────────────────────────

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
  private async resolvePeriod(
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
  private async dealNames(
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

  /**
   * Parts to per-deal contributions, preserving the exact totals.
   *
   * Integer addition only; nothing is rounded or re-derived, which is why the
   * grouped totals sum back to the ungrouped one.
   */
  private groupByDeal(
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
}

/** A stored part row as the pure module's `AccrualPart`. */
function toAccrualPart(row: typeof crmCommissionAccrualParts.$inferSelect): AccrualPart {
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

/**
 * The quota an earning was actually computed against, off its stored trace.
 *
 * `computation.quotaMinor` is written by `calculateForDeal` from the evaluation
 * it performed, so it is the number that was in force. Returning `undefined`
 * when it is absent or malformed makes the evaluator fall back to the version's
 * own `quotaMinor`, which is the same thing an earning with no override used.
 */
export function readQuotaMinor(
  computation: Record<string, unknown> | null | undefined,
): number | null | undefined {
  const value = computation?.["quotaMinor"];
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
