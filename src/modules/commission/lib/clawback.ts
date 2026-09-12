import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { crmCommissionEarnings } from "../../../db/schema/crm/commission";
import type { CommissionSlice } from "../commission-rules";
import { decomposeEvaluation } from "../commission-accrual";
import { periodAccruedMinor, recordAccrualForEarning } from "./accrual-ledger";

/**
 * Phase 5 ticket 06: a reversed or reclassified deal claws its commission
 * back through the same ledger that paid it.
 *
 * A second earning, never a mutation of the first — "The clawback is a
 * recorded entry, never a silent recalculation" is the ticket's own second
 * criterion, and `calculateEarningForDeal`'s unique index on
 * `(org, source_type, source_id, user)` already enforces "one row per source"
 * for a normal earning, which is exactly why the clawback is NOT one: it is
 * `source_type = "deal_reversal"` against the same `source_id`, a distinct
 * composite key the same index happily admits a second row under.
 *
 * The amount mirrors the original exactly rather than being recomputed under
 * today's rules. `apportion`'s rounding is "away from zero" specifically so
 * that "a clawback of a given size is the mirror of the earning of that
 * size" (see `commission-rules.ts`) — reusing the ORIGINAL evaluation's
 * `slices` at a negated total is what makes that literally true, rather than
 * merely aimed at. A plan version that changed since is irrelevant: this
 * reverses what was actually paid, not what today's rules would have paid.
 */
export interface ClawbackInput {
  readonly dealId: number;
  readonly reason: string;
  readonly actorUserId: string;
}

export interface ClawbackResult {
  readonly earning: typeof crmCommissionEarnings.$inferSelect;
  readonly reversedEarningId: string;
  readonly userId: string;
  readonly amountMinor: number;
  readonly currency: string;
  /**
   * True when this clawback drives the earner's period-to-date accrual
   * negative. The stated policy for that case (the ticket's fourth
   * criterion) is: record the full amount regardless — never a partial or
   * invented figure — and say so here, rather than silently letting a
   * snapshot go negative with nothing marking it as expected. What happens
   * next (an advance against the next period, a payroll deduction, a
   * write-off) is a payroll decision this module does not make.
   */
  readonly drivesNegative: boolean;
  readonly created: boolean;
}

function isCommissionSlice(value: unknown): value is CommissionSlice {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.fromMinor === "number" &&
    typeof v.toMinor === "number" &&
    typeof v.basisMinor === "number" &&
    typeof v.tierIndex === "number" &&
    typeof v.tierFrom === "number" &&
    typeof v.rateBps === "number" &&
    typeof v.multiplierBps === "number"
  );
}

/** The original evaluation's slices, read back off its own stored `computation`. */
function slicesOf(computation: Record<string, unknown> | null): CommissionSlice[] {
  const raw = computation?.slices;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isCommissionSlice)) {
    throw new BadRequestException(
      "The original earning's computation does not carry the slices this clawback needs to mirror — it predates this ticket or was written by something else.",
    );
  }
  return raw;
}

export async function clawbackEarningForDeal(
  db: Db,
  orgId: string,
  input: ClawbackInput,
): Promise<ClawbackResult> {
  return runInTenantTransaction(
    db,
    async (tx) => {
      const [original] = await tx
        .select()
        .from(crmCommissionEarnings)
        .where(
          and(
            eq(crmCommissionEarnings.orgId, orgId),
            eq(crmCommissionEarnings.sourceType, "deal"),
            eq(crmCommissionEarnings.sourceId, String(input.dealId)),
          ),
        )
        .orderBy(desc(crmCommissionEarnings.createdAt))
        .limit(1);
      if (!original)
        throw new NotFoundException("No commission was ever earned on this deal — nothing to claw back");
      if (original.status === "VOID")
        throw new BadRequestException("This earning was voided, not paid out — there is nothing to reverse");

      const slices = slicesOf(original.computation);
      const clawbackAmountMinor = -original.amountMinor;
      const parts = decomposeEvaluation({
        amountMinor: clawbackAmountMinor,
        effectiveRateBps: original.effectiveRateBps,
        attainmentBps: original.attainmentBps,
        quotaMinor:
          typeof original.computation?.quotaMinor === "number" ? original.computation.quotaMinor : null,
        capped: false,
        slices,
      });

      const accruedBefore = await periodAccruedMinor(tx, {
        orgId,
        userId: original.userId,
        planId: original.planId,
        periodStart: original.periodStart,
      });
      const drivesNegative = accruedBefore + clawbackAmountMinor < 0;

      const [inserted] = await tx
        .insert(crmCommissionEarnings)
        .values({
          orgId,
          planId: original.planId,
          planVersionId: original.planVersionId,
          userId: original.userId,
          earnedOn: original.earnedOn,
          periodStart: original.periodStart,
          periodEnd: original.periodEnd,
          sourceType: "deal_reversal",
          sourceId: String(input.dealId),
          basisMinor: -original.basisMinor,
          priorBasisMinor: original.priorBasisMinor,
          amountMinor: clawbackAmountMinor,
          currency: original.currency,
          effectiveRateBps: original.effectiveRateBps,
          attainmentBps: original.attainmentBps,
          computation: {
            reversedEarningId: original.earningId,
            reason: input.reason,
            actorUserId: input.actorUserId,
            slices,
            drivesNegative,
            accruedBeforeMinor: accruedBefore,
          },
        })
        .onConflictDoNothing()
        .returning();

      if (!inserted) {
        // Already clawed back — the unique index made this a no-op, the same
        // way a retried calculateForDeal is. Read the existing row back
        // rather than pretending a second reversal happened.
        const [existing] = await tx
          .select()
          .from(crmCommissionEarnings)
          .where(
            and(
              eq(crmCommissionEarnings.orgId, orgId),
              eq(crmCommissionEarnings.sourceType, "deal_reversal"),
              eq(crmCommissionEarnings.sourceId, String(input.dealId)),
              eq(crmCommissionEarnings.userId, original.userId),
            ),
          )
          .limit(1);
        if (!existing) throw new Error("Clawback insert conflicted but no existing row was found");
        return {
          earning: existing,
          reversedEarningId: original.earningId,
          userId: original.userId,
          amountMinor: existing.amountMinor,
          currency: existing.currency,
          drivesNegative: Boolean(existing.computation?.drivesNegative),
          created: false,
        };
      }

      await recordAccrualForEarning(tx, {
        orgId,
        earningId: inserted.earningId,
        userId: original.userId,
        planId: original.planId,
        planVersionId: original.planVersionId,
        earnedOn: original.earnedOn,
        periodStart: original.periodStart,
        periodEnd: original.periodEnd,
        sourceType: "deal_reversal",
        sourceId: String(input.dealId),
        currency: original.currency,
        amountMinor: clawbackAmountMinor,
        attainmentBps: original.attainmentBps,
        parts,
      });

      return {
        earning: inserted,
        reversedEarningId: original.earningId,
        userId: original.userId,
        amountMinor: clawbackAmountMinor,
        currency: original.currency,
        drivesNegative,
        created: true,
      };
    },
    { orgId },
  );
}
