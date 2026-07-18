import { z } from "zod";

export const updateCycleStatusSchema = z.object({
  status: z.string().trim().min(1).max(50),
});
export type UpdateCycleStatusInput = z.infer<typeof updateCycleStatusSchema>;
