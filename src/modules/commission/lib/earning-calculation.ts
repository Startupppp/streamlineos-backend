import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { deals } from "../../../db/schema/crm/deals";
import {
  crmCommissionEarnings,
  crmCommissionPlans,
  crmCommissionPlanVersions,
} from "../../../db/schema/crm/commission";
import { evaluateCommission, periodWindow } from "../commission-rules";
import { decomposeEvaluation } from "../commission-accrual";
import type { CalculateForDealInput } from "../dto/commission.schemas";
import { recordAccrualForEarning } from "./accrual-ledger";
import { assignmentOn, attainmentToDate, wonStageKeys } from "./earning-inputs";

/**
 * Saturate a reporting figure into `integer`'s range instead of failing the write.
 *
 * `attainment_bps` is int4, and attainment is `basis * 10000 / quota` — so a
 * plan whose quota is a handful of minor units produces a number past 2^31 and
 * Postgres refuses the INSERT with 22003. The commission would then not be
 * recorded at all because a *display* column overflowed. Saturating at
 * 2,147,483,647 bps — twenty-one million percent — cannot be misread as a real
 * attainment, and the money in `amount_minor` is untouched by it.
 */
const INT4_MAX = 2_147_483_647;
export function clampToInt4(value: number): number {
  if (value > INT4_MAX) return INT4_MAX;
  if (value < -INT4_MAX) return -INT4_MAX;
  return Math.trunc(value);
}

/**
 * The body of `CommissionService.calculateForDeal`, whose docblock states the
 * contract: every input is dated by the deal's close date, and the accrual is
 * written in the same transaction as the earning.
 */
export async function calculateEarningForDeal(
  db: Db,
  orgId: string,
  input: CalculateForDealInput,
) {
  return runInTenantTransaction(
    db,
    async (tx) => {
      const [deal] = await tx
        .select({
          id: deals.id,
          stage: deals.stage,
          valueMinor: deals.valueMinor,
          actualCloseDate: deals.actualCloseDate,
          assignedToId: deals.assignedToId,
        })
        .from(deals)
        .where(
          and(eq(deals.orgId, orgId), eq(deals.id, input.dealId), isNull(deals.deletedAt)),
        )
        .limit(1);
      if (!deal) throw new NotFoundException("Deal not found");

      const wonStages = await wonStageKeys(tx, orgId);
      if (!wonStages.includes(deal.stage))
        throw new BadRequestException(
          "Commission is earned on a won deal; this one is in stage " + deal.stage,
        );
      // The close date is the whole dating model's input. Refusing rather than
      // falling back to today is the point: "today" would make the same deal
      // compute differently depending on when somebody pressed the button.
      if (!deal.actualCloseDate)
        throw new BadRequestException(
          "This deal has no actual close date, so there is no date to price it on",
        );
      if (!deal.assignedToId)
        throw new BadRequestException("This deal has no owner to credit");

      const earnedOn = deal.actualCloseDate;
      const userId = deal.assignedToId;

      const assignment = await assignmentOn(tx, orgId, userId, earnedOn);
      if (!assignment)
        throw new BadRequestException(
          `The deal owner was on no commission plan on ${earnedOn}`,
        );

      const [version] = await tx
        .select()
        .from(crmCommissionPlanVersions)
        .where(
          and(
            eq(crmCommissionPlanVersions.orgId, orgId),
            eq(crmCommissionPlanVersions.planId, assignment.planId),
            lte(crmCommissionPlanVersions.effectiveFrom, earnedOn),
          ),
        )
        .orderBy(desc(crmCommissionPlanVersions.effectiveFrom))
        .limit(1);
      if (!version)
        throw new BadRequestException(
          `No version of this commission plan was in force on ${earnedOn}`,
        );

      const [plan] = await tx
        .select({ currency: crmCommissionPlans.currency })
        .from(crmCommissionPlans)
        .where(
          and(
            eq(crmCommissionPlans.orgId, orgId),
            eq(crmCommissionPlans.planId, assignment.planId),
          ),
        )
        .limit(1);

      const window = periodWindow(version.rules.period, earnedOn);
      const priorBasisMinor = await attainmentToDate(
        tx,
        orgId,
        userId,
        assignment.planId,
        window,
        String(deal.id),
      );

      const evaluation = evaluateCommission(version.rules, {
        basisMinor: deal.valueMinor,
        priorBasisMinor,
        quotaOverrideMinor: assignment.quotaOverrideMinor,
      });

      /**
       * `onConflictDoNothing`, then read back. The unique index on
       * (org, source_type, source_id, user) is what makes a retried request a
       * no-op instead of a second payment; without the read-back the caller
       * could not tell "already calculated" from "failed".
       */
      const [inserted] = await tx
        .insert(crmCommissionEarnings)
        .values({
          orgId,
          planId: assignment.planId,
          planVersionId: version.planVersionId,
          userId,
          earnedOn,
          periodStart: window.start,
          periodEnd: window.end,
          sourceType: "deal",
          sourceId: String(deal.id),
          basisMinor: deal.valueMinor,
          priorBasisMinor,
          amountMinor: evaluation.amountMinor,
          currency: plan?.currency ?? "INR",
          effectiveRateBps: clampToInt4(evaluation.effectiveRateBps),
          attainmentBps:
            evaluation.attainmentBps === null
              ? null
              : clampToInt4(evaluation.attainmentBps),
          computation: {
            quotaMinor: evaluation.quotaMinor,
            capped: evaluation.capped,
            slices: evaluation.slices,
            rules: version.rules,
            planVersionNumber: version.versionNumber,
            versionEffectiveFrom: version.effectiveFrom,
          },
        })
        .onConflictDoNothing()
        .returning();

      if (inserted) {
        /**
         * Accrue in the same transaction as the earning. This is what makes
         * accrual continuous rather than a month-end job: the figure people
         * watch and its decomposition move at the moment the deal is
         * calculated, not when somebody remembers to run something.
         *
         * Same transaction and not a follow-up call, because a request that
         * died between the two would leave an earning that no accrual counted
         * — and a figure that understates what somebody is owed, with nothing
         * on either row to say so. `recordAccrualForEarning` asserts that the
         * parts reconstruct `amountMinor` before it writes, so a decomposition
         * that does not add up takes the earning down with it rather than
         * being committed beside it.
         */
        await recordAccrualForEarning(tx, {
          orgId,
          earningId: inserted.earningId,
          userId,
          planId: assignment.planId,
          planVersionId: version.planVersionId,
          earnedOn,
          periodStart: window.start,
          periodEnd: window.end,
          sourceType: "deal",
          sourceId: String(deal.id),
          currency: plan?.currency ?? "INR",
          /**
           * The evaluation's own total, not the row read back.
           *
           * Parts and total then come from one evaluation, so the assertion
           * inside `recordAccrualForEarning` is checking that the
           * apportionment is self-consistent — which is the thing it can
           * actually prove. Whether the parts also match what was *persisted*
           * is a different claim, and the deferred constraint trigger
           * `trg_crm_commission_accrual_parts_reconcile` is what proves that,
           * against the stored row, at commit. Checking the same thing twice
           * against the same source would have looked like belt and braces
           * and been one strap.
           */
          amountMinor: evaluation.amountMinor,
          attainmentBps:
            evaluation.attainmentBps === null
              ? null
              : clampToInt4(evaluation.attainmentBps),
          parts: decomposeEvaluation(evaluation),
        });

        // Seal in the same transaction as the earning that sealed it. The
        // database trigger does this too; doing it here as well is what lets
        // the returned version be correct without a second round trip, and
        // keeps the property under unit test rather than only under a trigger
        // nothing hermetic can exercise.
        await tx
          .update(crmCommissionPlanVersions)
          .set({ sealedAt: new Date() })
          .where(
            and(
              eq(crmCommissionPlanVersions.orgId, orgId),
              eq(crmCommissionPlanVersions.planVersionId, version.planVersionId),
              isNull(crmCommissionPlanVersions.sealedAt),
            ),
          );
        return { earning: inserted, created: true };
      }

      const [existing] = await tx
        .select()
        .from(crmCommissionEarnings)
        .where(
          and(
            eq(crmCommissionEarnings.orgId, orgId),
            eq(crmCommissionEarnings.sourceType, "deal"),
            eq(crmCommissionEarnings.sourceId, String(deal.id)),
            eq(crmCommissionEarnings.userId, userId),
          ),
        )
        .limit(1);
      return { earning: existing ?? null, created: false };
    },
    { orgId },
  );
}
