import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

export const timesheetSettingsSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  workWeekStart: z.number().int(),
  requiredFields: z.unknown().nullable(),
  roundingRule: z.string(),
  maxHoursPerDay: z.string(),
  allowOverlappingEntries: z.boolean(),
  allowBackdatedEntries: z.boolean(),
  backdateLimitDays: z.number().int().nullable(),
  approvalMode: z.string(),
  approverSource: z.string(),
  clientApprovalEnabled: z.boolean(),
  lockAfterApproval: z.boolean(),
  lockAfterInvoice: z.boolean(),
  reminderRules: z.unknown().nullable(),
  payPeriod: z.string(),
  allowFutureEntries: z.boolean(),
  expectedDailyHours: z.string().nullable(),
  expectedWeeklyHours: z.string().nullable(),
  submissionGraceDays: z.number().int().nullable(),
  overtimeDailyHours: z.string(),
  overtimeWeeklyHours: z.string(),
  includeNonBillable: z.boolean(),
  payrollMapping: z.unknown().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const settingsHistorySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  version: z.number().int(),
  settings: z.unknown(),
  changedByMembershipId: z.number().int().nullable(),
  changeReason: z.string().nullable(),
  createdAt: wireDate(),
});

export const settingsHistoryListResponseSchema = z.array(settingsHistorySchema);
