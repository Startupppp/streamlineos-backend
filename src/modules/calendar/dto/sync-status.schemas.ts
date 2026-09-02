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
