import { z } from "zod";

/**
 * F4 — the proposal boundary.
 *
 * The property this file exists to hold: **a client cannot state a quantity.**
 * There is no field for one, on either request, so "order 5000 instead of 36"
 * is not a request this API can express — not rejected at runtime by a check
 * somebody could delete, but unrepresentable in the type the controller parses
 * into. The number comes from `PoBatchService`, which reads the persisted
 * proposal's reorder point against the live position and puts the shortfall
 * through the supplier's minimum and pack size.
 *
 * The same rule covers the vendor. A caller names a variant and, at most, a
 * site; the supplier is whatever the reorder rule or the product's default
 * says it is at the moment of confirm.
 */

export const invAiReorderProposalSchema = z
  .object({
    variantId: z.number().int().positive(),
    /**
     * Optional. Absent means the organisation-wide proposal, which is a
     * different persisted version from any site's — not "any site", and not a
     * wildcard the server picks from.
     */
    warehouseId: z.number().int().positive().optional(),
  })
  .strict();
export type InvAiReorderProposalInput = z.infer<typeof invAiReorderProposalSchema>;

/**
 * Confirming names the proposal and presents the token minted with it.
 *
 * Nothing else. Every figure the confirm acts on is re-read server-side: a
 * confirm that carried its own numbers would let the review step be skipped by
 * anyone willing to edit a request body.
 */
export const invAiConfirmProposalSchema = z
  .object({
    proposalId: z.number().int().positive(),
    token: z.string().min(1).max(512),
  })
  .strict();
export type InvAiConfirmProposalInput = z.infer<typeof invAiConfirmProposalSchema>;

/**
 * Why a proposal could not be made, distinguished from a proposal that says
 * "order nothing".
 *
 * `blocked` is the server refusing to propose — no supplier, already on a
 * draft, the position already covers the reorder point, the forecast engine
 * would not commit to a quantity. It is a success-shaped answer with a reason
 * attached, and crucially **no provider call is made for one**: narrating a
 * proposal that cannot exist is a bill for a paragraph nobody can act on.
 */
export type InvAiProposalStatus = "proposed" | "blocked";
