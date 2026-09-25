import { z } from "zod";

export const importSchema = z.object({
  fileName: z.string().min(1).max(255),
  content: z.string(),
  autoApprove: z.union([z.boolean(), z.string()]).optional(),
  /** The preview's choices: a category as written in the file -> an allowed category. */
  categoryMapping: z.record(z.string().max(100), z.string().max(100)).optional(),
  /**
   * The caller has seen the duplicate warnings and wants the duplicate rows filed
   * anyway. Absent, a duplicate row is reported and NOT inserted. [V-070b]
   */
  confirmDuplicates: z.union([z.boolean(), z.string()]).optional(),
}).strict();

export type ImportInput = z.infer<typeof importSchema>;
