import { z } from "zod";

export const createOvertimeSchema = z.object({
  date: z
    .string()
    .min(1, "Date is required")
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  hours: z
    .string()
    .min(1, "Hours worked overtime is required")
    .refine(
      (v) => {
        const n = parseFloat(v);
        return !isNaN(n);
      },
      { message: "Hours must be a valid number" },
    )
    .refine(
      (v) => {
        const n = parseFloat(v);
        return n > 0;
      },
      { message: "Hours must be greater than 0" },
    )
    .refine(
      (v) => {
        const n = parseFloat(v);
        return n <= 24;
      },
      { message: "Hours cannot exceed 24 per day" },
    ),
  reason: z.string().optional(),
  convertToCompOff: z.boolean().optional(),
});

export type CreateOvertimeInput = z.infer<typeof createOvertimeSchema>;
