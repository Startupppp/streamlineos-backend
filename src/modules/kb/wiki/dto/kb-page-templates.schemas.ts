import { z } from "zod";

export const createPageTemplateSchema = z.object({
  fromPageId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
}).strict();
export type CreatePageTemplateInput = z.infer<typeof createPageTemplateSchema>;
