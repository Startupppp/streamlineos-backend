import { z } from "zod";

export const rangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}).strict();
export type RangeInput = z.infer<typeof rangeSchema>;
