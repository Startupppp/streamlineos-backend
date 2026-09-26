import { z } from "zod";

export const updateIterationSettingsSchema = z
  .object({
    defaultDurationWeeks: z.number().int().min(1).max(4).optional(),
    namingPrefix: z
      .string()
      .min(1, "Naming prefix must be at least 1 character")
      .max(20, "Naming prefix must be 20 characters or fewer")
      .optional(),
  })
  .strict();

export type UpdateIterationSettingsInput = z.infer<
  typeof updateIterationSettingsSchema
>;

export const iterationSettingsResponseSchema = z.object({
  defaultDurationWeeks: z.number().int().min(1).max(4),
  namingPrefix: z.string(),
});
