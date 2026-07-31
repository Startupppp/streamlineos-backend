import { z } from "zod";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");

export const createRosterSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Roster name is required")
      .max(200, "Roster name must be at most 200 characters"),
    weekStart: dateOnly,
    weekEnd: dateOnly,
  })
  .refine((data) => data.weekEnd >= data.weekStart, {
    message: "Week end must be on or after week start",
    path: ["weekEnd"],
  });

export const upsertRosterEntrySchema = z.object({
  userId: z.string().trim().min(1, "Employee is required"),
  shiftId: z.coerce.number().int().positive().optional(),
  date: dateOnly,
  isDayOff: z.boolean().optional().default(false),
  notes: z.string().trim().max(500, "Notes must be at most 500 characters").optional(),
});

export type CreateRosterInput = z.infer<typeof createRosterSchema>;
export type UpsertRosterEntryInput = z.infer<typeof upsertRosterEntrySchema>;
