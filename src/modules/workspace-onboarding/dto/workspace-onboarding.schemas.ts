import { z } from "zod";

export const generateSchema = z.object({
  industry: z.string().min(1),
});

export type GenerateInput = z.infer<typeof generateSchema>;
