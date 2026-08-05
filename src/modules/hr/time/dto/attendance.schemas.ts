import { z } from "zod";

export const checkInSchema = z.object({
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      address: z.string().max(500).optional(),
    })
    .nullish(),
  localDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const checkOutSchema = z.object({
  localDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const monthlyQuerySchema = z.object({
  userId: z.string().optional(),
  year: z.coerce.number(),
  month: z.coerce.number(),
});

export const heatmapQuerySchema = z.object({
  userId: z.string().optional(),
  year: z.coerce.number().int().optional(),
});

export const attendanceLogsQuerySchema = z.object({
  userId: z.string().optional(),
  year: z.coerce.number().int().optional(),
  month: z.coerce.number().int().optional(),
});

export const selfMonthlyQuerySchema = monthlyQuerySchema.omit({ userId: true });
export const selfHeatmapQuerySchema = heatmapQuerySchema.omit({ userId: true });
export const selfAttendanceLogsQuerySchema = attendanceLogsQuerySchema.omit({
  userId: true,
});

export const teamStatusQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["PRESENT", "ON_BREAK", "CHECKED_OUT", "OFFLINE"]).optional(),
  departmentId: z.string().min(1).optional(),
});

export const attendanceEmailReportSchema = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).default([]),
  bcc: z.array(z.string().email()).default([]),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const holidayNameSchema = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(2, "Holiday name must be at least 2 characters")
      .max(100, "Holiday name must be at most 100 characters")
      .refine((v) => /[a-zA-Z]/.test(v), "Holiday name must contain at least one letter")
      .refine(
        (v) => /^[\p{L}\p{N}\s'.-]+$/u.test(v),
        "Holiday name can only use letters, numbers, spaces, apostrophes, periods, and hyphens",
      ),
  );

export const createOrgHolidaySchema = z.object({
  name: holidayNameSchema,
  date: z.string().min(1, "Date is required").regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  recurring: z.boolean().optional().default(false),
});

export const updateOrgHolidaySchema = z.object({
  name: holidayNameSchema.optional(),
  date: z.string().min(1).regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  recurring: z.boolean().optional(),
});

export type CheckInInput = z.infer<typeof checkInSchema>;
export type CheckOutInput = z.infer<typeof checkOutSchema>;
export type MonthlyQuery = z.infer<typeof monthlyQuerySchema>;
export type HeatmapQuery = z.infer<typeof heatmapQuerySchema>;
export type AttendanceLogsQuery = z.infer<typeof attendanceLogsQuerySchema>;
export type SelfMonthlyQuery = z.infer<typeof selfMonthlyQuerySchema>;
export type SelfHeatmapQuery = z.infer<typeof selfHeatmapQuerySchema>;
export type SelfAttendanceLogsQuery = z.infer<
  typeof selfAttendanceLogsQuerySchema
>;
export type TeamStatusQuery = z.infer<typeof teamStatusQuerySchema>;
export type AttendanceEmailReportInput = z.infer<typeof attendanceEmailReportSchema>;
export type CreateOrgHolidayInput = z.infer<typeof createOrgHolidaySchema>;
export type UpdateOrgHolidayInput = z.infer<typeof updateOrgHolidaySchema>;
