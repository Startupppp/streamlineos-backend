import { z } from "zod";

export const holidayCalendarQuerySchema = z.object({
  year: z.coerce.number().int().catch(0),
  month: z.coerce.number().int().catch(0),
});

export const updateHolidaySchema = z.object({
  name: z
    .string()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name must be at most 100 characters")
    .refine((v) => /[a-zA-Z]/.test(v), "Name must contain at least one letter")
    .refine((v) => !/\s{2,}/.test(v), "Name cannot have consecutive spaces"),
  date: z.string().min(1, "Date is required"),
  message: z.string().optional(),
});

export type HolidayCalendarQuery = z.infer<typeof holidayCalendarQuerySchema>;
export type UpdateHolidayInput = z.infer<typeof updateHolidaySchema>;
