import { z } from "zod";

/**
 * INV-208/B8 — `SyncBatchResult`.
 *
 * A per-operation outcome rather than a batch verdict: a device told only
 * "batch failed" has no way to know what to resend and will resend everything.
 * `code` travels beside `reason` for the same reason the contract exists at all
 * — a device that classified a conflict by matching the prose would break the
 * first time somebody reworded a message.
 */
export const syncBatchResponseSchema = z.object({
  applied: z.number().int(),
  duplicates: z.number().int(),
  conflicts: z.number().int(),
  failures: z.number().int(),
  results: z.array(
    z.object({
      clientOperationId: z.string(),
      outcome: z.string(),
      /** Present for everything except a clean apply. */
      reason: z.string().optional(),
      code: z.string().optional(),
    }),
  ),
});
