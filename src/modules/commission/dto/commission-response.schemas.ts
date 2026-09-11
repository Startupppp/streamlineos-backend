import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

/**
 * The shapes the commission routes return.
 *
 * Two conventions run through every schema here and both are load-bearing.
 * Money is integer minor units on a `bigint` column read in `mode: "number"`, so
 * it is a number and never the string a `numeric` would give. Dates that name a
 * DAY — `earnedOn`, `periodStart`, `effectiveFrom` — are `date` columns, which
 * postgres-js hands back as strings; only the `timestamp` columns are `Date`
 * objects and therefore `wireDate()`.
 */

/** `rules` jsonb on a plan version: `CommissionRuleSet`, evaluated as data. */
const commissionRuleSetSchema = z.object({
  basis: z.string(),
  period: z.enum(["MONTH", "QUARTER", "YEAR"]),
  /** Null means the bands read absolute basis rather than attainment. */
  quotaMinor: z.number().int().nullable(),
  tiers: z.array(z.object({ from: z.number(), rateBps: z.number().int() })),
  accelerators: z.array(
    z.object({ aboveBps: z.number().int(), multiplierBps: z.number().int() }),
  ),
  capMinor: z.number().int().nullable(),
});

const commissionPlanSchema = z.object({
  planId: z.string(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  currency: z.string(),
  retiredOn: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const commissionPlanVersionSchema = z.object({
  planVersionId: z.string(),
  orgId: z.string(),
  planId: z.string(),
  versionNumber: z.number().int(),
  effectiveFrom: z.string(),
  rules: commissionRuleSetSchema,
  /** Non-null once money has been computed from it; the version is then frozen. */
  sealedAt: nullableWireDate(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const commissionAssignmentSchema = z.object({
  assignmentId: z.string(),
  orgId: z.string(),
  planId: z.string(),
  userId: z.string(),
  effectiveFrom: z.string(),
  /** Inclusive last day; null while the person is still on the plan. */
  effectiveTo: z.string().nullable(),
  quotaOverrideMinor: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const commissionEarningSchema = z.object({
  earningId: z.string(),
  orgId: z.string(),
  planId: z.string(),
  planVersionId: z.string(),
  userId: z.string(),
  earnedOn: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  basisMinor: z.number().int(),
  priorBasisMinor: z.number().int(),
  amountMinor: z.number().int(),
  currency: z.string(),
  effectiveRateBps: z.number().int(),
  attainmentBps: z.number().int().nullable(),
  /** The evaluator's slice-by-slice trace; free-form by design. */
  computation: z.record(z.string(), z.unknown()).nullable(),
  status: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `listPlans` — the plan identities only, never a version's numbers. */
export const listCommissionPlansResponseSchema = z.array(
  z.object({
    planId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    currency: z.string(),
    retiredOn: z.string().nullable(),
    createdAt: wireDate(),
  }),
);

/** `createPlan` — never a plan on its own; see the service. */
export const createCommissionPlanResponseSchema = z.object({
  plan: commissionPlanSchema,
  version: commissionPlanVersionSchema,
});

/** `getPlan` — the plan with every version and assignment it has ever had. */
export const getCommissionPlanResponseSchema = z.object({
  plan: commissionPlanSchema,
  versions: z.array(commissionPlanVersionSchema),
  assignments: z.array(commissionAssignmentSchema),
});

export const commissionPlanResponseSchema = commissionPlanSchema;
export const commissionPlanVersionResponseSchema = commissionPlanVersionSchema;
export const commissionAssignmentResponseSchema = commissionAssignmentSchema;

/**
 * `calculate` — the earning, and whether this request is what created it.
 *
 * `earning` is null only on the recalculation path when the row the unique index
 * refused to duplicate could not be read back; `created` says which happened, so
 * a retry is distinguishable from a first computation.
 */
export const calculateEarningResponseSchema = z.object({
  earning: commissionEarningSchema.nullable(),
  created: z.boolean(),
});

export const listCommissionEarningsResponseSchema = z.array(commissionEarningSchema);

export const approveCommissionEarningResponseSchema = commissionEarningSchema;
