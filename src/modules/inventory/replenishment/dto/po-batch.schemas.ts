import { z } from "zod";

/**
 * C6 — batching persisted proposals into purchase orders.
 *
 * A proposal is a stored `inv_demand_forecasts` row: the forecast that was
 * actually recorded for a variant at a site, with its reorder point. The client
 * names **which** proposals, never how many units — the quantity is re-derived
 * from the stored reorder point against the live position, exactly as
 * `generatePo` re-derives its own (`inv-replenishment.service.ts`).
 */
const proposalIds = z.array(z.number().int().positive()).min(1).max(200);

/** What would be created, grouped, without writing anything. */
export const previewPoBatchSchema = z
  .object({
    proposalIds,
  })
  .strict();
export type PreviewPoBatchInput = z.infer<typeof previewPoBatchSchema>;

/**
 * Create one draft purchase order from a set of proposals.
 *
 * `vendorId` is the supplier the caller believes the batch belongs to, and it is
 * checked rather than trusted: a set spanning two suppliers is refused, because
 * one purchase order cannot be sent to two of them and quietly dropping the
 * odd one out is the worst of the three available behaviours.
 */
export const createPoBatchSchema = z
  .object({
    proposalIds,
    vendorId: z.number().int().positive(),
  })
  .strict();
export type CreatePoBatchInput = z.infer<typeof createPoBatchSchema>;

/** Which persisted proposals are available to batch. Paginated like every list (§3). */
export const batchableProposalsQuerySchema = z
  .object({
    warehouseId: z.coerce.number().int().positive().optional(),
    vendorId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type BatchableProposalsQuery = z.infer<typeof batchableProposalsQuerySchema>;
