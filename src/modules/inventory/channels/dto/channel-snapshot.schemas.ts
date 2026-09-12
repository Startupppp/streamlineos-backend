import { z } from "zod";

/**
 * E6 — the operator's half of channel snapshot reconciliation.
 *
 * `.strict()` on every object, per `inventory-strict-boundary.spec.ts`: Zod
 * strips unknown keys by default, so a client sending `orgId` or `internalQty`
 * would otherwise get a 2xx and no indication the field was discarded.
 */

export const listSnapshotDiffsQuerySchema = z.object({
  status: z.enum(["OPEN", "ACCEPTED", "DISMISSED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type ListSnapshotDiffsQueryInput = z.infer<typeof listSnapshotDiffsQuerySchema>;

/**
 * A note is mandatory on both resolutions, and long enough to be a sentence.
 *
 * Accepting a difference posts a stock movement whose only justification is that
 * a marketplace disagreed with us; dismissing one declares that disagreement
 * unimportant. Neither is a decision that should be reconstructible only from a
 * timestamp — and an empty-string reason is no reason, so the length is measured
 * after trimming.
 */
export const resolveSnapshotDiffSchema = z.object({
  note: z.string().trim().min(10, "Say why in at least a few words — this is the record of the decision").max(2000),
}).strict();
export type ResolveSnapshotDiffInput = z.infer<typeof resolveSnapshotDiffSchema>;
