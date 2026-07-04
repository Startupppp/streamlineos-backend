import { z } from "zod";

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
  })
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
  })
  .refine(rangeRefinement, { message: "end must be >= start" })
  .refine(dayLimitRefinement, { message: "date range must be ≤ 92 days" });

export const exportsListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

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
});

export type PeriodSummaryQuery = z.infer<typeof periodSummaryQuerySchema>;
export type ExportPayrollInput = z.infer<typeof exportPayrollSchema>;
export type ExportsListQuery = z.infer<typeof exportsListQuerySchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
export type PayrollMapping = z.infer<typeof payrollMappingSchema>;

export interface PayrollSummaryRow {
  userId: string;
  userName: string;
  userEmail: string;
  regularHours: number;
  overtimeHours: number;
  holidayHours: number;
  weekendHours: number;
  breakHours: number;
  leaveDays: number;
  billableHours: number;
  nonBillableHours: number;
  totalPayableHours: number;
  entryCount: number;
  exportedHours: number;
  hasPendingEntries: boolean;
  pendingHours: number;
}

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

export interface TimesheetExportDto {
  id: number;
  exportType: string;
  status: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  format: string;
  entryCount: number;
  totalHours: number;
  note: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface PayrollSettingsDto {
  payPeriod: string;
  overtimeDailyHours: number;
  overtimeWeeklyHours: number;
  includeNonBillable: boolean;
  payrollMapping: PayrollMapping;
}
