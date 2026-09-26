import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";
import { DB_ENUMS } from "../../../../db/enums.generated";

export const runListItemSchema = z.object({
  id: z.number().int(),
  month: z.string(),
  status: z.enum(DB_ENUMS.payroll_run_status),
  runType: z.string(),
  entityId: z.number().int().nullable(),
  statutoryRuleVersion: z.string().nullable(),
  grossTotal: z.string().nullable(),
  netTotal: z.string().nullable(),
  employeeCount: z.number().int().nullable(),
  exceptionCount: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const payrollRunSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  policyVersionId: z.number().int().nullable(),
  month: z.string(),
  runType: z.string(),
  sourcePeriodKey: z.string().nullable(),
  sourceRunId: z.number().int().nullable(),
  entityId: z.number().int().nullable(),
  periodId: z.number().int().nullable(),
  calculationVersion: z.string().nullable(),
  statutoryRuleVersion: z.string().nullable(),
  inputSnapshotHash: z.string().nullable(),
  status: z.enum(DB_ENUMS.payroll_run_status),
  payDate: z.string().nullable(),
  grossTotal: z.string(),
  deductionTotal: z.string(),
  employerCostTotal: z.string(),
  netTotal: z.string(),
  employeeCount: z.number().int(),
  exceptionCount: z.number().int(),
  lockedAt: nullableWireDate(),
  lockedBy: z.string().nullable(),
  lockedByMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  approvedByMembershipId: z.number().int().nullable(),
  paidAt: nullableWireDate(),
  paidBy: z.string().nullable(),
  paidByMembershipId: z.number().int().nullable(),
  publishedAt: nullableWireDate(),
  publishedBy: z.string().nullable(),
  publishedByMembershipId: z.number().int().nullable(),
  closedAt: nullableWireDate(),
  closedBy: z.string().nullable(),
  closedByMembershipId: z.number().int().nullable(),
  reopenedAt: nullableWireDate(),
  reopenedBy: z.string().nullable(),
  reopenedByMembershipId: z.number().int().nullable(),
  reopenReason: z.string().nullable(),
  postingState: z.enum(["pending", "posted", "failed"]),
  generationLockToken: z.string().nullable(),
  generationLockedAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const checklistItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  done: z.boolean(),
  href: z.string().nullable(),
  detail: z.string().nullable(),
});

const varianceSummarySchema = z.object({
  previousMonth: z.string().nullable(),
  currentNet: z.string(),
  previousNet: z.string(),
  netDelta: z.string(),
  netDeltaPercent: z.number(),
  newJoiners: z.number().int(),
  exited: z.number().int(),
  changedEmployees: z.number().int(),
});

const payoutHealthSchema = z.object({
  failedCount: z.number().int(),
  heldCount: z.number().int(),
});

export const runDetailResponseSchema = z.object({
  run: payrollRunSchema,
  checklist: z.array(checklistItemSchema),
  varianceSummary: varianceSummarySchema.nullable(),
  payoutHealth: payoutHealthSchema.nullable(),
});

export const runCreateResponseSchema = z.object({
  runId: z.number().int(),
  correlationId: z.string(),
  warning: z.string().optional(),
});

export const generateResponseSchema = z.object({
  ok: z.literal(true),
  correlationId: z.string(),
});

export const runEmployeeListItemSchema = z.object({
  id: z.number().int(),
  userId: z.string().nullable(),
  workerType: z.enum(DB_ENUMS.payroll_worker_type),
  currency: z.string(),
  gross: z.string(),
  totalDeductions: z.string(),
  net: z.string(),
  status: z.string(),
  holdReason: z.string().nullable(),
  userName: z.string().nullable(),
  userEmail: z.string(),
});

export const runEmployeeDetailSchema = z.object({
  id: z.number().int(),
  userId: z.string().nullable(),
  workerType: z.enum(DB_ENUMS.payroll_worker_type),
  currency: z.string(),
  gross: z.string(),
  totalDeductions: z.string(),
  net: z.string(),
  status: z.string(),
  holdReason: z.string().nullable(),
  calculationSnapshot: z.record(z.string(), z.unknown()).nullable(),
  userName: z.string().nullable(),
  userEmail: z.string(),
});

export const runListEmployeesResponseSchema = cursorPageSchema(runEmployeeListItemSchema);

const varianceRunSummarySchema = z.object({
  id: z.number().int(),
  month: z.string(),
  grossTotal: z.string(),
  netTotal: z.string(),
});

const topMoverSchema = z.object({
  userId: z.string().nullable(),
  net: z.string(),
  userName: z.string().nullable(),
  paidDays: z.string(),
  lopDays: z.string(),
  baselineSource: z.string().nullable(),
  inputBaseline: z.object({
    lockedPaidDays: z.string().nullable(),
    lockedLopDays: z.string().nullable(),
    paidDaysDelta: z.number().nullable(),
    lopDaysDelta: z.number().nullable(),
  }).nullable(),
  netDeltaPercent: z.number().nullable(),
});

export const runVarianceResponseSchema = z.object({
  currentRun: varianceRunSummarySchema,
  previousRun: varianceRunSummarySchema.nullable(),
  topMovers: z.array(topMoverSchema),
  lockedInputBaselinesUsed: z.boolean(),
});

export const exceptionItemSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  severity: z.enum(["BLOCKER", "WARNING", "INFO"]),
  status: z.enum(["OPEN", "RESOLVED", "OVERRIDDEN"]),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  userId: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: nullableWireDate(),
  overrideReason: z.string().nullable(),
  createdAt: wireDate(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
});

export const inputItemSchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  source: z.enum(["ATTENDANCE", "LEAVE", "TIMESHEET", "UPLOAD", "MANUAL"]),
  scheduledDays: z.string(),
  paidDays: z.string(),
  lopDays: z.string(),
  halfDays: z.string(),
  overtimeHours: z.string(),
  shiftAllowanceUnits: z.string(),
  holidayWorkDays: z.string(),
  billableHours: z.string(),
  isOverride: z.boolean(),
  overrideReason: z.string().nullable(),
  createdAt: wireDate(),
  userName: z.string().nullable(),
  userEmail: z.string(),
});

export const reimportResponseSchema = z.object({
  ok: z.literal(true),
  count: z.number().int(),
});

