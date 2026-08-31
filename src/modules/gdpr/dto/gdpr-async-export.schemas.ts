import { z } from "zod";

export const gdprAsyncExportBodySchema = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

export type GdprAsyncExportBody = z.infer<typeof gdprAsyncExportBodySchema>;
