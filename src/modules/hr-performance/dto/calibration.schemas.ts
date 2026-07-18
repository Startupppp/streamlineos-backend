import { z } from "zod";

export const upsertCalibrationEntrySchema = z.object({
  employeeId: z.string().uuid(),
  preRating: z.string().max(50).optional(),
  postRating: z.string().max(50).optional(),
  note: z.string().max(2000).optional(),
});
export type UpsertCalibrationEntryInput = z.infer<typeof upsertCalibrationEntrySchema>;
