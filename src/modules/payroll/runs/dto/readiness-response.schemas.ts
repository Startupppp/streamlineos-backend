import { z } from "zod";
import { payrollPeopleReadinessSchema } from "./payroll-people.schemas";
import { nullableWireDate } from "../../../../common/openapi/wire-types";

export const READINESS_STAGE_KEYS = [
  "timesheets_approved",
  "timesheets_exported",
  "handoff_received",
  "handoff_acknowledged",
  "inputs_locked",
  "run_generated",
] as const;

export const READINESS_EXCEPTION_CODES = [
  "TIMESHEETS_AWAITING_APPROVAL",
  "APPROVED_HOURS_NOT_EXPORTED",
  "PERIOD_CHANGED_AFTER_EXPORT",
  "EXPORT_REJECTED",
] as const;

export const readinessStageStatusSchema = z.enum(["done", "pending", "blocked", "not_applicable"]);
export const readinessOwnerSchema = z.object({ label: z.string(), permission: z.string() });
export const readinessActionSchema = z.object({ label: z.string(), href: z.string() });

export const readinessStageSchema = z.object({
  key: z.enum(READINESS_STAGE_KEYS),
  label: z.string(),
  status: readinessStageStatusSchema,
  owner: readinessOwnerSchema,
  at: nullableWireDate(),
  detail: z.string(),
  action: readinessActionSchema.nullable(),
});

export const readinessExportSchema = z.object({
  id: z.number().int(),
  exportedAt: z.string(),
  dateRangeStart: z.string(),
  dateRangeEnd: z.string(),
  entryCount: z.number().int(),
  totalHours: z.string(),
  workerCount: z.number().int(),
  receivedAt: nullableWireDate(),
  ackStatus: z.string().nullable(),
  ackAt: nullableWireDate(),
  ackNote: z.string().nullable(),
});

export const readinessExceptionSchema = z.object({
  code: z.enum(READINESS_EXCEPTION_CODES),
  severity: z.enum(["blocker", "warning"]),
  message: z.string(),
  owner: readinessOwnerSchema,
  action: readinessActionSchema.nullable(),
  period: z
    .object({
      periodId: z.number().int(),
      userId: z.string().nullable(),
      userName: z.string().nullable(),
      userEmail: z.string().nullable(),
      periodStart: z.string(),
      periodEnd: z.string(),
      status: z.string(),
      exportId: z.number().int(),
      exportedEntryCount: z.number().int(),
      exportedHours: z.string(),
      changedAt: z.string(),
    })
    .nullable(),
});

export const payrollReadinessResponseSchema = z.object({
  month: z.string(),
  window: z.object({ start: z.string(), end: z.string() }),
  cutoff: z.object({ type: z.string(), date: z.string(), title: z.string() }).nullable(),
  timesheets: z.object({
    unsubmitted: z.number().int(),
    awaitingApproval: z.number().int(),
    approved: z.number().int(),
    locked: z.number().int(),
    rejected: z.number().int(),
    approvedHoursNotExported: z.string(),
    approvedEntriesNotExported: z.number().int(),
  }),
  inputs: z.object({ status: z.string().nullable(), lockedAt: nullableWireDate() }),
  run: z.object({ id: z.number().int(), status: z.string(), createdAt: z.string() }).nullable(),
  stages: z.array(readinessStageSchema),
  exports: z.array(readinessExportSchema),
  exceptions: z.array(readinessExceptionSchema),
  people: payrollPeopleReadinessSchema,
});

export type PayrollReadiness = z.infer<typeof payrollReadinessResponseSchema>;
export type ReadinessStage = z.infer<typeof readinessStageSchema>;
export type ReadinessException = z.infer<typeof readinessExceptionSchema>;
export type ReadinessExport = z.infer<typeof readinessExportSchema>;
export type ReadinessOwner = z.infer<typeof readinessOwnerSchema>;
