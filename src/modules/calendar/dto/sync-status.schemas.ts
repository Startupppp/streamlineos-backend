import { z } from "zod";

export const syncStatusResponseSchema = z.object({
  status: z.enum(["synced", "pending", "in_flight", "failed", "not_synced"]),
  attemptCount: z.number(),
  lastError: z.string().nullable(),
  operation: z.enum(["create", "update", "delete"]).nullable(),
  queuedAt: z.string().nullable(),
  processedAt: z.string().nullable(),
  retryable: z.boolean(),
});

export type SyncStatusResponse = z.infer<typeof syncStatusResponseSchema>;

export const syncRetryResponseSchema = z.object({
  requeued: z.number(),
});

export type SyncRetryResponse = z.infer<typeof syncRetryResponseSchema>;

/**
 * `cancelled` counts the queue rows actually withdrawn, and it is deliberately a count
 * rather than a boolean: a row already claimed by the sweep (IN_FLIGHT), already pushed
 * (PROCESSED) or already terminal (FAILED) is NOT cancellable, so a caller who asked to
 * cancel a job that had just been picked up gets `0` and can tell the difference.
 */
export const syncCancelResponseSchema = z.object({
  cancelled: z.number(),
});

export type SyncCancelResponse = z.infer<typeof syncCancelResponseSchema>;
