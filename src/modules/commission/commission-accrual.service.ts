import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { crmCommissionEarnings, crmCommissionPlanVersions } from "../../db/schema/crm/commission";
import { evaluateCommission } from "./commission-rules";
import { decomposeEvaluation } from "./commission-accrual";
import { recordAccrualForEarning, utcToday } from "./lib/accrual-ledger";
import { readPeriodAccrual } from "./lib/accrual-period";
import { readAccrualCurve, readDealAccrual, readEarningDecomposition } from "./lib/accrual-reads";
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
 * deliberately — `toMinor`, in `lib/accrual-parts.ts` — and never by coincidence.
 *
 * The class is the entry point and keeps `rebuild`; the rest lives in `lib/`:
 * `accrual-ledger.ts` writes a decomposition and its curve point,
 * `accrual-period.ts` and `accrual-reads.ts` hold the reads, and
 * `accrual-parts.ts` the row helpers they share.
 */

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
    return readPeriodAccrual(this.db, orgId, query, viewer);
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
    return readEarningDecomposition(this.db, orgId, earningId, viewer);
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
    return readDealAccrual(this.db, orgId, dealId, viewer);
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
    return readAccrualCurve(this.db, orgId, query, viewer);
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
