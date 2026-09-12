import { z } from "zod";

/**
 * D2 — the filters a reviewer actually reaches for.
 *
 * `lotId` is the recall question ("where did this lot go, and on whose
 * authority"), `clientId` the complaint question ("what short-dated stock has
 * this customer been sent"), `verdict` the audit question ("show me every time
 * a contracted shelf life was set aside"). Each has a matching partial index.
 *
 * Cursor only, no `page`: an append-only trail has no stable offsets to hand
 * out, and offering one invites the defect the ledger lists were migrated away
 * from.
 */
export const listAllocationOverridesSchema = z.object({
  lotId: z.coerce.number().int().positive().optional(),
  clientId: z.coerce.number().int().positive().optional(),
  productVariantId: z.coerce.number().int().positive().optional(),
  verdict: z.enum(["NEAR_EXPIRY", "SHELF_LIFE"]).optional(),
  actorUserId: z.string().min(1).max(64).optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
}).strict();

export type ListAllocationOverridesInput = z.infer<typeof listAllocationOverridesSchema>;
