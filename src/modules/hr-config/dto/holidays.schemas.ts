import { z } from "zod";

export const holidayCalendarQuerySchema = z.object({
  year: z.coerce.number().int().catch(0),
  month: z.coerce.number().int().catch(0),
});

export const holidayListQuerySchema = z.object({
  year: z.coerce.number().int().catch(0),
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

export const createHolidaySchema = z.object({
  name: z
    .string()
    .min(2, "Holiday name must be at least 2 characters")
    .max(100, "Holiday name must be at most 100 characters")
    .refine((v) => /[a-zA-Z]/.test(v.trim()), "Holiday name must contain at least one letter")
    .refine((v) => !/\s{2,}/.test(v), "Holiday name cannot have consecutive spaces"),
  date: z
    .string()
    .min(1, "Date is required")
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  message: z.string().max(500, "Message too long").optional(),
  isPublic: z.boolean().optional().default(false),
});

export type HolidayCalendarQuery = z.infer<typeof holidayCalendarQuerySchema>;
export type HolidayListQuery = z.infer<typeof holidayListQuerySchema>;
export type UpdateHolidayInput = z.infer<typeof updateHolidaySchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
