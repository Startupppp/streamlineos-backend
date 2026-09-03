import { z } from "zod";

export const categorizeSuggestSchema = z.object({
  merchant: z.string().min(1).max(300),
}).strict();

export type CategorizeSuggestInput = z.infer<typeof categorizeSuggestSchema>;
