import { z } from "zod";
import {
  BPS_SCALE,
  COMMISSION_BASES,
  COMMISSION_PERIODS,
} from "../../../db/schema/crm/commission";

/**
 * The contract for commission plan data.
 *
 * This is where "rules are data, not code" is actually enforced. Every rate,
 * boundary, quota and multiplier arrives through these schemas as an integer,
 * and the invariants the evaluator relies on — ascending tiers, a first band at
 * zero, a positive quota — are rejected here rather than repaired, so a stored
 * plan and the payout it produces can never disagree about what the plan says.
 *
 * Nothing accepts a fractional rate. A rate is basis points and a sum of money
 * is minor units; admitting `5.5` anywhere would put a float on the path to a
 * payout, which is the drift `deals.valueMinor` exists to have ended.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date, YYYY-MM-DD");

/** 0 to 100% of the basis. A rate above the basis is a typo, not a plan. */
const rateBps = z.number().int().min(0).max(BPS_SCALE);

const minorUnits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const tierSchema = z
  .object({
    /** Attainment bps when the version has a quota, minor units when it does not. */
    from: z.number().int().min(0),
    rateBps,
  })
  .strict();

const acceleratorSchema = z
  .object({
    aboveBps: z.number().int().min(0),
    /** 10000 = 1x. Capped at 5x: beyond that it is far likelier to be a unit error. */
    multiplierBps: z.number().int().min(1).max(50_000),
  })
  .strict();

export const ruleSetSchema = z
  .object({
    basis: z.enum(COMMISSION_BASES),
    period: z.enum(COMMISSION_PERIODS),
    quotaMinor: minorUnits.positive().nullable().default(null),
    tiers: z.array(tierSchema).min(1).max(20),
    accelerators: z.array(acceleratorSchema).max(10).default([]),
    capMinor: minorUnits.positive().nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.tiers[0]!.from !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["tiers", 0, "from"],
        // Not defaulted to 0 for them: a plan whose author believed the first
        // band started at their quota would silently pay the top rate from the
        // first pound.
        message: "the first tier must start at 0 so every basis falls in a band",
      });

    for (let i = 1; i < value.tiers.length; i += 1) {
      if (value.tiers[i]!.from <= value.tiers[i - 1]!.from)
        ctx.addIssue({
          code: "custom",
          path: ["tiers", i, "from"],
          message: "tiers must be strictly ascending; equal bounds make the payout order-dependent",
        });
    }

    const thresholds = new Set<number>();
    for (const [i, accelerator] of value.accelerators.entries()) {
      if (thresholds.has(accelerator.aboveBps))
        ctx.addIssue({
          code: "custom",
          path: ["accelerators", i, "aboveBps"],
          message: "two accelerators at the same threshold; only one could ever apply",
        });
      thresholds.add(accelerator.aboveBps);
    }

    if (value.quotaMinor === null) {
      for (const [i, accelerator] of value.accelerators.entries())
        if (accelerator.aboveBps > 0)
          ctx.addIssue({
            code: "custom",
            path: ["accelerators", i, "aboveBps"],
            // Without a quota there is no attainment to compare against, so the
            // threshold would be read as 0 and the accelerator would apply to
            // everything — an unbounded rate rise nobody asked for.
            message: "an accelerator threshold needs a quota to be measured against",
          });
    }
  });

export const createPlanSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    currency: z.string().length(3).default("INR"),
    effectiveFrom: isoDate,
    rules: ruleSetSchema,
    note: z.string().max(2000).optional(),
  })
  .strict();

export const updatePlanSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    /**
     * No `currency` and no rules. Both would restate what past earnings mean
     * while leaving the plan looking untouched — the exact move this module
     * exists to make impossible. Money changes go through a new version.
     */
    retiredOn: isoDate.nullable().optional(),
  })
  .strict();

export const createVersionSchema = z
  .object({
    effectiveFrom: isoDate,
    rules: ruleSetSchema,
    note: z.string().max(2000).optional(),
  })
  .strict();

/** Only reachable while a version is unsealed; the service re-checks. */
export const updateVersionSchema = z
  .object({
    effectiveFrom: isoDate.optional(),
    rules: ruleSetSchema.optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const assignSchema = z
  .object({
    userId: z.string().min(1),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable().default(null),
    quotaOverrideMinor: minorUnits.positive().nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom)
      ctx.addIssue({
        code: "custom",
        path: ["effectiveTo"],
        message: "an assignment cannot end before it starts",
      });
  });

export const endAssignmentSchema = z
  .object({ effectiveTo: isoDate })
  .strict();

export const calculateForDealSchema = z
  .object({
    dealId: z.number().int().positive(),
  })
  .strict();

export const resolveVersionQuerySchema = z
  .object({
    on: isoDate,
  })
  .strict();

export const listEarningsQuerySchema = z
  .object({
    userId: z.string().min(1).optional(),
    planId: z.string().min(1).optional(),
    status: z.enum(["CALCULATED", "APPROVED", "PAID", "VOID"]).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    /** Hard cap. An unbounded ledger read is a way to take the database down. */
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
export type CreateVersionInput = z.infer<typeof createVersionSchema>;
export type UpdateVersionInput = z.infer<typeof updateVersionSchema>;
export type AssignInput = z.infer<typeof assignSchema>;
export type EndAssignmentInput = z.infer<typeof endAssignmentSchema>;
export type CalculateForDealInput = z.infer<typeof calculateForDealSchema>;
export type ResolveVersionQuery = z.infer<typeof resolveVersionQuerySchema>;
export type ListEarningsQuery = z.infer<typeof listEarningsQuerySchema>;
