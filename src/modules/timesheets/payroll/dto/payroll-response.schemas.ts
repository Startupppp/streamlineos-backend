import { z } from "zod";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const payrollSummaryRowSchema = z.object({
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
  entryCount: z.number().int(),
  exportedHours: z.number(),
  hasPendingEntries: z.boolean(),
  pendingHours: z.number(),
});

export const payrollPeriodSummaryResponseSchema = z.object({
  period: z.object({ start: z.string(), end: z.string() }),
  totals: z.object({
    payableHours: z.number(),
    regularHours: z.number(),
    overtimeHours: z.number(),
    holidayHours: z.number(),
    weekendHours: z.number(),
    breakHours: z.number(),
    billableHours: z.number(),
    nonBillableHours: z.number(),
    userCount: z.number().int(),
    entryCount: z.number().int(),
    exportedHours: z.number(),
    pendingApprovalHours: z.number(),
    pendingApprovalCount: z.number().int(),
    pendingUserCount: z.number().int(),
  }),
  rows: z.array(payrollSummaryRowSchema),
  exceptions: z.object({
    pendingApprovals: z.array(z.object({
      userId: z.string(),
      userName: z.string(),
      entryCount: z.number().int(),
      hours: z.number(),
    })),
  }),
});

const timesheetExportDtoSchema = z.object({
  id: z.number().int(),
  exportType: z.string(),
  status: z.string(),
  dateRangeStart: z.string(),
  dateRangeEnd: z.string(),
  format: z.string(),
  entryCount: z.number().int(),
  totalHours: z.number(),
  note: z.string().nullable(),
  ackStatus: z.string().nullable(),
  ackAt: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});

export const payrollExportListResponseSchema = cursorPageSchema(timesheetExportDtoSchema);

const payrollExportRowSchema = z.object({
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

const payrollMappingColumnSchema = z.object({
  key: z.string(),
  header: z.string(),
  enabled: z.boolean(),
});

const payrollMappingSchema = z.object({
  provider: z.enum(["GENERIC", "ZOHO_PAYROLL", "RAZORPAYX", "ADP", "GUSTO"]),
  columns: z.array(payrollMappingColumnSchema),
});

export const payrollExportRowsResponseSchema = z.object({
  export: timesheetExportDtoSchema,
  rows: z.array(payrollExportRowSchema),
  mapping: payrollMappingSchema.nullable(),
});

export const payrollRunExportResponseSchema = z.object({
  export: timesheetExportDtoSchema,
  rows: z.array(payrollExportRowSchema),
});

export const payrollAckExportResponseSchema = z.object({
  export: timesheetExportDtoSchema,
});

export const payrollSettingsResponseSchema = z.object({
  payPeriod: z.string(),
  overtimeDailyHours: z.number(),
  overtimeWeeklyHours: z.number(),
  includeNonBillable: z.boolean(),
  payrollMapping: payrollMappingSchema,
});
