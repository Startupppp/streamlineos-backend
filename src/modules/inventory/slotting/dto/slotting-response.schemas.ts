import { z } from "zod";
import { nullableWireDate, wireDate } from "../../../../common/openapi/wire-types";
import { createTransferResponseSchema } from "../../stock/dto/stock-response.schemas";

/**
 * NEO-6 — slotting on the wire.
 *
 * The three shapes here mirror the three things the module keeps apart: a rule
 * says where a class of SKU should live, a recommendation says where stock is
 * and where the rules put it, and the sweep says how many organisations it
 * managed to recompute. None of them moves stock, and the contract says so —
 * the only transfer in this file is the one `approve` hands back after raising
 * it through the ordinary command.
 */
const slottingRuleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  warehouseId: z.number().int(),
  name: z.string(),
  matchType: z.string(),
  velocityClass: z.string().nullable(),
  categoryId: z.number().int().nullable(),
  productVariantId: z.number().int().nullable(),
  targetZoneLocationId: z.number().int(),
  targetLocationType: z.string().nullable(),
  priority: z.number().int(),
  isActive: z.boolean(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const slottingRecommendationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  warehouseId: z.number().int(),
  productVariantId: z.number().int(),
  fromLocationId: z.number().int(),
  /** The zone the rule points at; the bin is chosen when the move is approved. */
  toZoneLocationId: z.number().int(),
  quantity: z.string(),
  ruleId: z.number().int().nullable(),
  reason: z.string(),
  status: z.string(),
  transferId: z.number().int().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listSlottingRulesResponseSchema = z.array(slottingRuleSchema);

export const slottingRuleResponseSchema = slottingRuleSchema;

export const listSlottingRecommendationsResponseSchema = z.array(slottingRecommendationSchema);

/** Dismissing keeps the row: "we looked and decided not to" is a fact. */
export const dismissSlottingRecommendationResponseSchema = slottingRecommendationSchema;

/**
 * Approving marks the decision, names the bin, and hands back the ordinary
 * transfer the controller raised for it — a re-slot is a ledger fact like any
 * other rather than a second posting path.
 */
export const approveSlottingRecommendationResponseSchema = z.object({
  recommendation: slottingRecommendationSchema,
  move: z.object({
    productVariantId: z.number().int(),
    fromLocationId: z.number().int(),
    toLocationId: z.number().int(),
    quantity: z.string(),
  }),
  transfer: createTransferResponseSchema,
});

/** The nightly sweep. Read-only: it recomputes velocity and proposes moves. */
export const reslotSweepResponseSchema = z.object({
  organizations: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
});
