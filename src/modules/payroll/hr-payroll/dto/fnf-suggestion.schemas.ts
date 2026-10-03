import { z } from "zod";

export const fnfSuggestionQuerySchema = z
  .object({
    userId: z.string().min(1),
    lastWorkingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  })
  .strict();
export type FnfSuggestionQuery = z.infer<typeof fnfSuggestionQuerySchema>;

export const fnfSuggestionResponseSchema = z.object({
  userId: z.string(),
  joiningDate: z.string().nullable(),
  lastWorkingDay: z.string(),
  lastDrawnBasic: z.string().nullable(),
  basicMonth: z.string().nullable(),
  serviceYears: z.number().int(),
  serviceMonths: z.number().int(),
  gratuityYears: z.number().int(),
  gratuityEligible: z.boolean(),
  gratuityCapped: z.boolean(),
  gratuity: z.string(),
  encashableLeaveDays: z.string(),
  leaveEncashment: z.string(),
  notes: z.array(z.string()),
});
