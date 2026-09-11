import { z } from "zod";

export const gdprErasureBodySchema = z
  .object({
    reason: z.string().min(1).max(500),
    dryRun: z.boolean().optional().default(false),
  })
  .strict();

export type GdprErasureBody = z.infer<typeof gdprErasureBodySchema>;
