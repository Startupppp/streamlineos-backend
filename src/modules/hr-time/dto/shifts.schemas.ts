import { z } from "zod";

const SHIFT_TYPES = ["FIXED", "ROTATIONAL", "NIGHT", "FLEXIBLE"] as const;

const shiftNameSchema = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(3, "Shift name must be at least 3 characters")
      .max(100, "Shift name must be at most 100 characters")
      .refine(
        (v) => /^[\p{L}\p{N}\s'.-]+$/u.test(v),
        "Shift name can only use letters, numbers, spaces, apostrophes, periods, and hyphens",
      )
      .refine(
        (v) => !/[^\p{L}\p{N}\s]{2,}/u.test(v),
        "Shift name cannot have consecutive special characters",
      )
      .refine(
        (v) => (v.match(/[a-zA-Z]/g) ?? []).length >= 3,
        "Shift name must contain at least 3 letters",
      ),
  );

export const createShiftSchema = z.object({
  name: shiftNameSchema,
  type: z.enum(SHIFT_TYPES).default("FIXED"),
  startTime: z.string().min(1, "Start time is required"),
  endTime: z.string().min(1, "End time is required"),
  breakMinutes: z.coerce.number().int().min(0).max(480).optional().default(60),
  gracePeriodMinutes: z.coerce.number().int().min(0).max(120).optional().default(15),
  isNightShift: z.boolean().optional().default(false),
});

export const updateShiftSchema = z.object({
  name: shiftNameSchema.optional(),
  type: z.enum(SHIFT_TYPES).optional(),
  startTime: z.string().min(1).optional(),
  endTime: z.string().min(1).optional(),
  breakMinutes: z.coerce.number().int().min(0).max(480).optional(),
  gracePeriodMinutes: z.coerce.number().int().min(0).max(120).optional(),
  isNightShift: z.boolean().optional(),
});

export type CreateShiftInput = z.infer<typeof createShiftSchema>;
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>;
