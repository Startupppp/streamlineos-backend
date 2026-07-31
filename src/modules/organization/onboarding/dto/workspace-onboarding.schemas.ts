import { z } from "zod";

export const generateSchema = z.object({
  industry: z.string().min(1),
  enabledModules: z.array(z.string()).optional(),
});

export type GenerateInput = z.infer<typeof generateSchema>;
