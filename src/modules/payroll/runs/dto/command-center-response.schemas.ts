import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const exceptionCountsSchema = z.object({
  BLOCKER: z.number().int(),
  WARNING: z.number().int(),
  INFO: z.number().int(),
});

const commandCenterHeaderSchema = z.object({
  runId: z.number().int().nullable(),
  month: z.string(),
  status: z.string().nullable(),
  grossTotal: z.string(),
  deductionTotal: z.string(),
  netTotal: z.string(),
  employerCostTotal: z.string(),
  employeeCount: z.number().int(),
  exceptionCounts: exceptionCountsSchema,
});

const commandCenterChecklistItemSchema = z.object({
  key: z.enum([
    "employees_verified", "attendance_imported", "inputs_locked",
    "reimbursements_approved", "variable_pay_approved", "loans_applied",
    "tax_declarations_locked", "preview_generated", "exceptions_resolved",
    "payroll_approved", "bank_file_generated", "payslips_published",
  ]),
  label: z.string(),
  done: z.boolean(),
  href: z.string().nullable(),
  detail: z.string().nullable(),
});

const topExceptionSchema = z.object({
  id: z.number().int(),
  runEmployeeId: z.number().int(),
  userId: z.string().nullable(),
  code: z.string(),
  severity: z.enum(["BLOCKER", "WARNING", "INFO"]),
  message: z.string(),
  status: z.string(),
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

const pendingApprovalSchema = z.object({
  id: z.number().int(),
  stage: z.number().int(),
  status: z.string(),
});

const packComplianceChecklistItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  detail: z.string(),
});

const commandCenterPanelsSchema = z.object({
  runStatus: z.string().nullable(),
  topExceptions: z.array(topExceptionSchema),
  varianceSummary: varianceSummarySchema.nullable(),
  pendingApprovals: z.array(pendingApprovalSchema),
  payoutReadiness: z.boolean(),
  statutoryReadiness: z.object({
    taxDeclarationsLocked: z.boolean(),
    packComplianceChecklist: z.array(packComplianceChecklistItemSchema),
  }),
});

const upcomingCalendarEventSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  policyId: z.number().int().nullable(),
  month: z.string().nullable(),
  type: z.enum([
    "ATTENDANCE_CUTOFF", "REIMBURSEMENT_CUTOFF", "DECLARATION_CUTOFF",
    "PREVIEW_DUE", "APPROVAL_DEADLINE", "PAY_DATE", "PUBLISH_DATE",
  ]),
  date: z.string(),
  title: z.string(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const commandCenterResponseSchema = z.object({
  header: commandCenterHeaderSchema,
  checklist: z.array(commandCenterChecklistItemSchema),
  panels: commandCenterPanelsSchema,
  upcomingCalendarEvents: z.array(upcomingCalendarEventSchema),
});
