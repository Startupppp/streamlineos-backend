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

/**
 * C2 — an exact quantity, as the decimal string it is.
 *
 * A `z.number()` here would put a float between a person typing "30" and the
 * `numeric(18,4)` column the order line lives in, which is the one hop
 * `exact.ts` exists to prevent. The regex is the column's own shape: up to
 * fourteen integer digits and four decimals, which is what `numeric(18,4)`
 * holds. Nothing calls `Number()` on it at any point afterwards.
 */
const exactQuantity = z
  .string()
  .trim()
  .regex(
    /^\d{1,14}(\.\d{1,4})?$/,
    "A quantity is a positive number with at most four decimal places.",
  );

/**
 * C2 — a human overruling the engine, said out loud.
 *
 * This is deliberately not a `suggestedQty` on a line. An override is a
 * *different act* from approving a proposal: it names the proposal it overrules
 * and it carries a reason, and the server records both beside the order it
 * produced. A quantity that arrived as an ordinary field would be
 * indistinguishable from the engine's own answer the moment the line was
 * written, which is exactly the state C2 removes.
 *
 * The reason has a floor rather than being merely non-empty. "n/a" and "." are
 * what a required-but-unenforced field collects, and a reason nobody can read
 * six months later is the same as no reason at all.
 */
export const proposalOverrideSchema = z
  .object({
    proposalId: z.number().int().positive(),
    quantity: exactQuantity,
    reason: z.string().trim().min(10).max(500),
  })
  .strict();
export type ProposalOverrideInput = z.infer<typeof proposalOverrideSchema>;

const proposalOverrides = z.array(proposalOverrideSchema).max(200).default([]);

/** What would be created, grouped, without writing anything. */
export const previewPoBatchSchema = z
  .object({
    proposalIds,
    overrides: proposalOverrides,
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
    overrides: proposalOverrides,
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
