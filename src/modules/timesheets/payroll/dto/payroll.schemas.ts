import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function rangeRefinement(d: { start: string; end: string }): boolean {
  return d.end >= d.start;
}

function dayLimitRefinement(d: { start: string; end: string }): boolean {
  const s = new Date(d.start).getTime();
  const e = new Date(d.end).getTime();
  return (e - s) / (1000 * 60 * 60 * 24) <= 92;
}

export const periodSummaryQuerySchema = z
  .object({
    start: dateString,
    end: dateString,
    userId: z.string().optional(),
    includeExported: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  }).strict()
  .refine(rangeRefinement, { message: "end must be >= start" })
  .refine(dayLimitRefinement, { message: "date range must be ≤ 92 days" });

export const exportPayrollSchema = z
  .object({
    start: dateString,
    end: dateString,
    format: z.enum(["CSV", "XLSX"]),
    userIds: z.array(z.string()).max(500).optional(),
    includeExported: z.boolean().default(false),
    note: z.string().max(500).optional(),
  }).strict()
  .refine(rangeRefinement, { message: "end must be >= start" })
  .refine(dayLimitRefinement, { message: "date range must be ≤ 92 days" });

export const exportsListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
}).strict();

export const ackExportSchema = z.object({
  status: z.enum(["RECEIVED", "ACCEPTED", "REJECTED", "FAILED"]),
  note: z.string().max(1000).optional(),
}).strict();

const VALID_COLUMN_KEYS = new Set([
  "employeeName",
  "employeeEmail",
  "employeeId",
  "periodStart",
  "periodEnd",
  "regularHours",
  "overtimeHours",
  "holidayHours",
  "weekendHours",
  "breakHours",
  "leaveDays",
  "billableHours",
  "nonBillableHours",
  "totalPayableHours",
  "entryCount",
]);

export const payrollMappingColumnSchema = z.object({
  key: z.string(),
  header: z.string().min(1).max(60),
  enabled: z.boolean(),
});

export const payrollMappingSchema = z
  .object({
    provider: z.enum(["GENERIC", "ZOHO_PAYROLL", "RAZORPAYX", "ADP", "GUSTO"]),
    columns: z
      .array(payrollMappingColumnSchema)
      .refine((cols) => cols.every((c) => VALID_COLUMN_KEYS.has(c.key)), {
        message: "columns contain unknown keys",
      }),
  });

export const updateSettingsSchema = z.object({
  payPeriod: z.enum(["WEEKLY", "BIWEEKLY", "SEMIMONTHLY", "MONTHLY"]).optional(),
  overtimeDailyHours: z.number().min(0.5).max(24).optional(),
  overtimeWeeklyHours: z.number().min(1).max(168).optional(),
  includeNonBillable: z.boolean().optional(),
  payrollMapping: payrollMappingSchema.optional(),
}).strict();

export type PeriodSummaryQuery = z.infer<typeof periodSummaryQuerySchema>;
export type ExportPayrollInput = z.infer<typeof exportPayrollSchema>;
export type ExportsListQuery = z.infer<typeof exportsListQuerySchema>;
export type AckExportInput = z.infer<typeof ackExportSchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
export type PayrollMapping = z.infer<typeof payrollMappingSchema>;

export const payrollSummaryRowSchema = z.object({
  userId: z.string(),
  userName: z.string(),
  userEmail: z.string(),
  regularHours: z.number(),
  overtimeHours: z.number(),
  holidayHours: z.number(),
  weekendHours: z.number(),
  breakHours: z.number(),
  leaveDays: z.number(),
  billableHours: z.number(),
  nonBillableHours: z.number(),
  totalPayableHours: z.number(),
  entryCount: z.number(),
  exportedHours: z.number(),
  hasPendingEntries: z.boolean(),
  pendingHours: z.number(),
});

export type PayrollSummaryRow = z.infer<typeof payrollSummaryRowSchema>;

export const payrollExportRowSchema = z.object({
  userId: z.string(),
  employeeName: z.string(),
  employeeEmail: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  regularHours: z.number(),
  overtimeHours: z.number(),
  holidayHours: z.number(),
  weekendHours: z.number(),
  breakHours: z.number(),
  leaveDays: z.number(),
  billableHours: z.number(),
  nonBillableHours: z.number(),
  totalPayableHours: z.number(),
  entryCount: z.number(),
});

export const payrollSnapshotSchema = z.array(payrollExportRowSchema);

export type PayrollExportRow = z.infer<typeof payrollExportRowSchema>;

export const timesheetExportSchema = z.object({
  id: z.number(),
  exportType: z.string(),
  status: z.string(),
  dateRangeStart: z.string(),
  dateRangeEnd: z.string(),
  format: z.string(),
  entryCount: z.number(),
  totalHours: z.number(),
  note: z.string().nullable(),
  ackStatus: z.string().nullable(),
  ackAt: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});

export type TimesheetExportDto = z.infer<typeof timesheetExportSchema>;

export const payrollSettingsDtoSchema = z.object({
  payPeriod: z.enum(["WEEKLY", "BIWEEKLY", "SEMIMONTHLY", "MONTHLY"]),
  overtimeDailyHours: z.number(),
  overtimeWeeklyHours: z.number(),
  includeNonBillable: z.boolean(),
  payrollMapping: payrollMappingSchema,
});

export type PayrollSettingsDto = z.infer<typeof payrollSettingsDtoSchema>;
