import { z } from "zod";

export const reconciliationQuerySchema = z
  .object({
    warehouseId: z.coerce.number().int().positive().optional(),
    productVariantId: z.coerce.number().int().positive().optional(),
    /** Hard cap: this is a full scan of the ledger for the selected grains. */
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ReconciliationQueryInput = z.infer<typeof reconciliationQuerySchema>;

export const repairSchema = z
  .object({
    /**
     * Defaults to a dry run. Writing requires the caller to say so, because the
     * report alone cannot distinguish drift from a rebuild that is mid-flight.
     */
    apply: z.boolean().default(false),
    warehouseId: z.number().int().positive().optional(),
    productVariantId: z.number().int().positive().optional(),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type RepairInput = z.infer<typeof repairSchema>;
