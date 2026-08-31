import { z } from "zod";

export const exportRequestBodySchema = z.object({
  reason: z.string().min(1).max(500).optional(),
}).strict();

export type ExportRequestBody = z.infer<typeof exportRequestBodySchema>;
