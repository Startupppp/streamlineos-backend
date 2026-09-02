import { z } from "zod";

export const importSchema = z.object({
  fileName: z.string().min(1).max(255),
  content: z.string(),
  autoApprove: z.union([z.boolean(), z.string()]).optional(),
}).strict();

export type ImportInput = z.infer<typeof importSchema>;
