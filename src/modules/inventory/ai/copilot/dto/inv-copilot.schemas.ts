import { z } from "zod";

/**
 * F2 — the copilot's boundary.
 *
 * Two properties this file is responsible for. First, the caller supplies a
 * question and at most a few *ids* — never a tool name, never a filter, never
 * anything that reaches SQL as anything but a bound parameter. Second, the
 * question is bounded: an unbounded question is a prompt-injection carrier with
 * a token bill attached, and `.max()` is the only thing between a pasted
 * document and a paid call over it.
 */

/**
 * Long enough for a real operational question ("why is SKU-7 short at the
 * Pune warehouse and when does the open PO land?"), short enough that nobody
 * pastes a policy document into it.
 */
export const COPILOT_QUESTION_MAX = 500;

export const invCopilotAskSchema = z
  .object({
    question: z.string().trim().min(3).max(COPILOT_QUESTION_MAX),
    /**
     * Optional focus. These arrive when the operator asked from a record rather
     * than from a blank box, and they are ids the server re-resolves under the
     * asker's org and warehouse scope — so an id from another tenant simply
     * finds nothing, which is the 404-shaped answer §4 requires rather than a
     * 403 that would confirm the row exists.
     */
    variantId: z.number().int().positive().optional(),
    warehouseId: z.number().int().positive().optional(),
    vendorId: z.number().int().positive().optional(),
  })
  .strict();
export type InvCopilotAskInput = z.infer<typeof invCopilotAskSchema>;

/**
 * The complete set of things the copilot can do. Every member reads; none
 * writes. The list is closed at the type level so a tool cannot be reached by
 * naming it — the model picks a member, and the member is looked up in a table
 * this repository owns.
 */
export const INV_COPILOT_TOOLS = [
  "current_stock",
  "available_to_promise",
  "recent_movements",
  "open_purchase_orders",
  "active_reservations",
  "expiring_lots",
  "vendor_delay",
] as const;
export type InvCopilotToolName = (typeof INV_COPILOT_TOOLS)[number];

/**
 * The only thing a model is permitted to contribute to retrieval: which of the
 * seven it wants, and no more than three of them.
 *
 * There is deliberately no argument field. Arguments come from the request DTO
 * and from the server's own parse of the question; a model that could name a
 * filter could name someone else's warehouse, and "the model asked for it" is
 * not an authorization.
 */
export const invCopilotPlanSchema = z
  .object({
    tools: z.array(z.enum(INV_COPILOT_TOOLS)).min(1).max(3),
  })
  .strict();
export type InvCopilotPlan = z.infer<typeof invCopilotPlanSchema>;
