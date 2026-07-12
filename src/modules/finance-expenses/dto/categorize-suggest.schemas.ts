import { z } from "zod";

export const categorizeSuggestSchema = z.object({
  merchant: z.string().min(1).max(300),
  amount: z.number().nonnegative().optional(),
});

export type CategorizeSuggestInput = z.infer<typeof categorizeSuggestSchema>;
