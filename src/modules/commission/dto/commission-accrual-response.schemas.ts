import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";
import { commissionEarningSchema } from "./commission-response.schemas";

/**
 * The accrual reads, and the one write beside them.
 *
 * `reconciles` appears on three of the four and means the same thing each time:
 * the itemisation returned accounts for the whole of the headline figure. It is
 * a claim the payload makes rather than one this file describes, which is the
 * ticket's acceptance test expressed in the response.
 */

/** One band of one earning, as `crm_commission_accrual_parts` stores it. */
const accrualPartRowSchema = z.object({
  partId: z.string(),
  orgId: z.string(),
  earningId: z.string(),
  userId: z.string(),
  planId: z.string(),
  planVersionId: z.string(),
  earnedOn: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  partIndex: z.number().int(),
  tierIndex: z.number().int(),
  tierFrom: z.number().int(),
  rateBps: z.number().int(),
  multiplierBps: z.number().int(),
  sliceFromMinor: z.number().int(),
  sliceToMinor: z.number().int(),
  basisMinor: z.number().int(),
  amountMinor: z.number().int(),
  currency: z.string(),
  createdAt: wireDate(),
});

/** `summariseByRule` — parts rolled up by the band that paid them. */
const ruleContributionSchema = z.object({
  tierIndex: z.number().int(),
  tierFrom: z.number().int(),
  rateBps: z.number().int(),
  multiplierBps: z.number().int(),
  basisMinor: z.number().int(),
  amountMinor: z.number().int(),
  partCount: z.number().int(),
});

/** `groupByDeal` — one earning's contribution, with its own rule roll-up. */
const dealContributionSchema = z.object({
  sourceType: z.string(),
  sourceId: z.string(),
  /** Null when the deal has since been removed. */
  dealName: z.string().nullable(),
  earningId: z.string(),
  planId: z.string(),
  planVersionId: z.string(),
  earnedOn: z.string(),
  basisMinor: z.number().int(),
  amountMinor: z.number().int(),
  rules: z.array(ruleContributionSchema),
});

export const periodAccrualResponseSchema = z.object({
  userId: z.string(),
  planId: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  period: z.enum(["MONTH", "QUARTER", "YEAR"]),
  asOf: z.string(),
  amountMinor: z.number().int(),
  basisMinor: z.number().int(),
  currency: z.string(),
  attainmentBps: z.number().int().nullable(),
  dealCount: z.number().int(),
  partCount: z.number().int(),
  itemisedPartCount: z.number().int(),
  /** True means `deals` and `rules` are a page of the period, not the period. */
  truncated: z.boolean(),
  deals: z.array(dealContributionSchema),
  rules: z.array(ruleContributionSchema),
  reconciles: z.object({ byDeal: z.boolean(), byRule: z.boolean() }),
});

/** `readAccrualCurve` — the stored end-of-day points, never recomputed. */
export const accrualCurveResponseSchema = z.object({
  userId: z.string(),
  points: z.array(
    z.object({
      snapshotId: z.string(),
      orgId: z.string(),
      userId: z.string(),
      planId: z.string(),
      periodStart: z.string(),
      periodEnd: z.string(),
      asOfDate: z.string(),
      accruedMinor: z.number().int(),
      basisMinor: z.number().int(),
      earningCount: z.number().int(),
      partCount: z.number().int(),
      attainmentBps: z.number().int().nullable(),
      currency: z.string(),
      computedAt: wireDate(),
    }),
  ),
});

/** `readDealAccrual` — what one deal paid, to whom, under which band. */
export const dealAccrualResponseSchema = z.object({
  sourceType: z.string(),
  sourceId: z.string(),
  amountMinor: z.number().int(),
  basisMinor: z.number().int(),
  partCount: z.number().int(),
  truncated: z.boolean(),
  parts: z.array(accrualPartRowSchema),
  rules: z.array(ruleContributionSchema),
  reconciles: z.boolean(),
});

/**
 * `readEarningDecomposition` — one earning taken apart.
 *
 * `reconciles` false means the row predates its decomposition or had one written
 * around the ledger writer; the rebuild is the repair. It is stated rather than
 * thrown, because a caller asking to see a broken derivation should get the row
 * and the fact that it is broken.
 */
export const earningDecompositionResponseSchema = z.object({
  earning: commissionEarningSchema,
  parts: z.array(accrualPartRowSchema),
  rules: z.array(ruleContributionSchema),
  reconciles: z.boolean(),
  decomposedMinor: z.number().int(),
});

/**
 * `rebuild` — what it re-derived, and what it deliberately would not.
 *
 * `drifted` names earnings whose stored total no longer reproduces: those are
 * reported and skipped rather than reconciled, because a payout that has moved
 * is a conversation and not a repair.
 */
export const rebuildAccrualResponseSchema = z.object({
  examined: z.number().int(),
  rebuilt: z.number().int(),
  partsWritten: z.number().int(),
  drifted: z.array(z.string()),
  skipped: z.array(z.string()),
});
