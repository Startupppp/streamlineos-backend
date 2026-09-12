import { z } from "zod";

/**
 * F3 — the demand-risk narrative's boundary.
 *
 * Two ids and nothing else. There is deliberately no horizon, no service level,
 * no history window and no method on this payload: every one of those is an
 * input to the forecast, and a request that could set them would be a request
 * that computes a forecast. This surface narrates a forecast the C-wave engine
 * already made; it does not commission one.
 */
export const demandRiskSchema = z
  .object({
    variantId: z.number().int().positive(),
    /**
     * Optional. Absent means the organisation, which `scopeFor` refuses for a
     * caller restricted to specific warehouses — an org-wide demand series
     * aggregates sites they cannot see.
     */
    warehouseId: z.number().int().positive().optional(),
  })
  .strict();
export type DemandRiskInput = z.infer<typeof demandRiskSchema>;
