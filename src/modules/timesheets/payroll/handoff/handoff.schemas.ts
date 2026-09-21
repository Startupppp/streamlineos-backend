import { z } from "zod";
import { payrollMappingSchema } from "../dto/payroll.schemas";

export const handoffWorkerRowSchema = z.object({
  userId: z.string().min(1),
  employeeName: z.string(),
  employeeEmail: z.string(),
  regularHours: z.number(),
  overtimeHours: z.number(),
  holidayHours: z.number(),
  weekendHours: z.number(),
  leaveDays: z.number(),
  billableHours: z.number(),
  nonBillableHours: z.number(),
  totalPayableHours: z.number(),
  entryCount: z.number().int().nonnegative(),
});

export const payrollHandoffPayloadSchema = z.object({
  organizationId: z.string().min(1),
  exportId: z.number().int().positive(),
  periodStart: z.string(),
  periodEnd: z.string(),
  currency: z.string().length(3).nullable(),
  entryCount: z.number().int().nonnegative(),
  totalHours: z.number(),
  mapping: payrollMappingSchema,
  rows: z.array(handoffWorkerRowSchema),
  idempotencyKey: z.string().min(1),
  ackPath: z.string().min(1),
  exportedAt: z.string(),
});

export type PayrollHandoffPayload = z.infer<typeof payrollHandoffPayloadSchema>;
export type HandoffWorkerRow = z.infer<typeof handoffWorkerRowSchema>;

export const payrollExportReadyEventSchema = z.object({
  organization_id: z.string().min(1),
  export_id: z.number().int().positive(),
  period_start: z.string(),
  period_end: z.string(),
  entry_count: z.number().int().nonnegative(),
  worker_count: z.number().int().nonnegative(),
  total_hours: z.string(),
  format: z.string(),
  actor_user_id: z.string().min(1),
});

export type PayrollExportReadyEvent = z.infer<typeof payrollExportReadyEventSchema>;

export const payrollAckPayloadSchema = z.object({
  organizationId: z.string().min(1),
  exportId: z.number().int().positive(),
  status: z.enum(["RECEIVED", "ACCEPTED", "REJECTED", "FAILED"]),
  note: z.string().nullable(),
  ackAt: z.string(),
  ackBy: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

export type PayrollAckPayload = z.infer<typeof payrollAckPayloadSchema>;

export const payrollExportAckedEventSchema = z.object({
  organization_id: z.string().min(1),
  export_id: z.number().int().positive(),
  status: z.enum(["RECEIVED", "ACCEPTED", "REJECTED", "FAILED"]),
  note: z.string().nullable(),
  acked_at: z.string(),
  actor_user_id: z.string().min(1),
});

export type PayrollExportAckedEvent = z.infer<typeof payrollExportAckedEventSchema>;

export const TIMESHEET_EVENTS = {
  payrollExportReady: "timesheets.payroll.export.ready",
  payrollExportAcked: "timesheets.payroll.export.acked",
} as const;
