import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";
import { getTodayString } from "../../../../common/date/date.utils";

export const checkInSchema = z.object({
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      address: z.string().max(500).optional(),
    })
    .nullish(),
}).strict();

export const checkOutSchema = z.object({}).strict();

export const monthlyQuerySchema = z.object({
  userId: z.string().optional(),
  year: z.coerce.number(),
  month: z.coerce.number(),
}).strict();

export const heatmapQuerySchema = z.object({
  userId: z.string().optional(),
  year: z.coerce.number().int().optional(),
}).strict();

export const attendanceLogsQuerySchema = z.object({
  userId: z.string().optional(),
  year: z.coerce.number().int().optional(),
  month: z.coerce.number().int().optional(),
}).strict();

export const selfMonthlyQuerySchema = monthlyQuerySchema.omit({ userId: true }).strict();
export const selfHeatmapQuerySchema = heatmapQuerySchema.omit({ userId: true }).strict();
export const selfAttendanceLogsQuerySchema = attendanceLogsQuerySchema.omit({
  userId: true,
}).strict();

export const selfAttendanceHistoryQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
}).strict();

export const REGULARIZATION_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

function isRealCalendarDate(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The client sends an absolute timestamp built from a local wall-clock time, so
 * its UTC date legitimately differs from attendanceDate by up to a day in either
 * direction. Bound it to that window rather than demanding an exact date match.
 */
function fallsOnDate(iso: string, dateStr: string): boolean {
  const ts = new Date(iso).getTime();
  const base = new Date(`${dateStr}T00:00:00Z`).getTime();
  if (Number.isNaN(ts) || Number.isNaN(base)) return false;
  return ts >= base - DAY_MS && ts < base + 2 * DAY_MS;
}

export const createAttendanceRegularizationSchema = z
  .object({
    attendanceDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isRealCalendarDate, { message: "That date does not exist" })
      .refine((value) => value <= getTodayString(), {
        message: "You cannot request a correction for a future date",
      })
      .refine(
        (value) =>
          value >= shiftDays(getTodayString(), -REGULARIZATION_WINDOW_DAYS),
        {
          message: `Corrections are only allowed within the last ${REGULARIZATION_WINDOW_DAYS} days`,
        },
      ),
    requestedCheckIn: z.string().datetime().optional(),
    requestedCheckOut: z.string().datetime().optional(),
    reason: z.string().min(10).max(500),
  })
  .strict()
  .refine(
    (value) =>
      !value.requestedCheckIn ||
      fallsOnDate(value.requestedCheckIn, value.attendanceDate),
    {
      message: "Check-in time must fall on the selected date",
      path: ["requestedCheckIn"],
    },
  )
  .refine(
    (value) =>
      !value.requestedCheckOut ||
      fallsOnDate(value.requestedCheckOut, value.attendanceDate),
    {
      message: "Check-out time must fall on the selected date",
      path: ["requestedCheckOut"],
    },
  )
  .refine((value) => value.requestedCheckIn || value.requestedCheckOut, {
    message: "Provide a corrected check-in or check-out time",
    path: ["requestedCheckIn"],
  })
  .refine(
    (value) =>
      !value.requestedCheckIn ||
      !value.requestedCheckOut ||
      new Date(value.requestedCheckOut) > new Date(value.requestedCheckIn),
    {
      message: "Check-out must be after check-in",
      path: ["requestedCheckOut"],
    },
  );

export const teamStatusQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: pageSizeField(50, 100),
    search: z.string().trim().min(1).max(200).optional(),
    status: z.enum(["PRESENT", "ON_BREAK", "CHECKED_OUT", "OFFLINE"]).optional(),
    departmentId: z.string().min(1).optional(),
  })
  .strict();

export const ATTENDANCE_REPORT_RECIPIENT_LIMIT = 10;
export const ATTENDANCE_REPORT_MAX_DAYS = 31;

const reportEmailSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().email().max(320));

function parseDateOnly(value: string): Date | null {
  const parts = value.split("-").map(Number);
  const [year, month, day] = parts;
  if (year === undefined || month === undefined || day === undefined) return null;

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

const reportDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format")
  .refine((value) => parseDateOnly(value) !== null, "Enter a valid calendar date");

export const attendanceEmailReportSchema = z
  .object({
    to: z.array(reportEmailSchema).min(1).max(ATTENDANCE_REPORT_RECIPIENT_LIMIT),
    cc: z.array(reportEmailSchema).max(ATTENDANCE_REPORT_RECIPIENT_LIMIT).default([]),
    bcc: z.array(reportEmailSchema).max(ATTENDANCE_REPORT_RECIPIENT_LIMIT).default([]),
    startDate: reportDateSchema.optional(),
    endDate: reportDateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const recipients = [...value.to, ...value.cc, ...value.bcc];
    if (recipients.length > ATTENDANCE_REPORT_RECIPIENT_LIMIT) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: `Select at most ${ATTENDANCE_REPORT_RECIPIENT_LIMIT} recipients`,
      });
    }
    if (new Set(recipients).size !== recipients.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "Each recipient can appear only once",
      });
    }

    if (Boolean(value.startDate) !== Boolean(value.endDate)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: value.startDate ? ["endDate"] : ["startDate"],
        message: "Select both a start date and an end date",
      });
      return;
    }

    if (!value.startDate || !value.endDate) return;
    const start = parseDateOnly(value.startDate);
    const end = parseDateOnly(value.endDate);
    if (!start || !end) return;

    const dayCount = (end.getTime() - start.getTime()) / 86_400_000 + 1;
    if (dayCount < 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endDate"],
        message: "End date must be on or after the start date",
      });
    } else if (dayCount > ATTENDANCE_REPORT_MAX_DAYS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endDate"],
        message: `Date range cannot exceed ${ATTENDANCE_REPORT_MAX_DAYS} days`,
      });
    }
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
}).strict();

export const updateOrgHolidaySchema = z.object({
  name: holidayNameSchema.optional(),
  date: z.string().min(1).regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  recurring: z.boolean().optional(),
}).strict();

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
export type SelfAttendanceHistoryQuery = z.infer<
  typeof selfAttendanceHistoryQuerySchema
>;
export type CreateAttendanceRegularizationInput = z.infer<
  typeof createAttendanceRegularizationSchema
>;
export type TeamStatusQuery = z.infer<typeof teamStatusQuerySchema>;
export type AttendanceEmailReportInput = z.infer<typeof attendanceEmailReportSchema>;
export type CreateOrgHolidayInput = z.infer<typeof createOrgHolidaySchema>;
export type UpdateOrgHolidayInput = z.infer<typeof updateOrgHolidaySchema>;

export const listRegularizationsSchema = z.object({
  userId: z.string().optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: pageSizeField(20, 100),
});
export const rejectRegularizationSchema = z.object({
  rejectionReason: z.string().min(1).max(500),
});
