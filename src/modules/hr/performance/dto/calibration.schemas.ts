import { z } from "zod";

const ratingString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d)?$/, "Rating must be a number with at most 1 decimal place")
  .refine((v) => Number(v) >= 1 && Number(v) <= 5, "Rating must be between 1 and 5");

export const upsertCalibrationEntrySchema = z.object({
  employeeId: z.string().trim().min(1, "Employee is required"),
  preRating: ratingString,
  postRating: ratingString,
  note: z.string().trim().max(2000, "Note must be at most 2000 characters").optional(),
}).strict();

export type UpsertCalibrationEntryInput = z.infer<typeof upsertCalibrationEntrySchema>;
