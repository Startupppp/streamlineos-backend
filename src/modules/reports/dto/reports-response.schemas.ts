import { z } from "zod";

export const sourceEffectivenessSchema = z.array(
  z.object({
    source: z.string(),
    total: z.number().int(),
    hired: z.number().int(),
    rejected: z.number().int(),
    hireRate: z.number(),
  }),
);
