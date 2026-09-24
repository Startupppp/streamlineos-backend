import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { reminderRulesSchema } from "./reminder-rules.schemas";
import {
  timesheetApproverSourceSchema,
  timesheetConfigurableApprovalModeSchema,
  timesheetRoundingRuleSchema,
} from "./status.schemas";

export const storedRequiredFieldsSchema = z.array(z.string()).catch([]);

export function parseStoredRequiredFields(value: unknown): string[] {
  return storedRequiredFieldsSchema.parse(value);
}

export const updateCoreSettingsSchema = z.object({
  workWeekStart: z.number().int().min(0).max(6).optional(),
  requiredFields: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  roundingRule: timesheetRoundingRuleSchema.optional(),
  maxHoursPerDay: z.number().positive().max(24).optional(),
  allowOverlappingEntries: z.boolean().optional(),
  allowBackdatedEntries: z.boolean().optional(),
  backdateLimitDays: z.number().int().positive().optional().nullable(),
  approvalMode: timesheetConfigurableApprovalModeSchema.optional(),
  approverSource: timesheetApproverSourceSchema.optional(),
  clientApprovalEnabled: z.boolean().optional(),
  lockAfterApproval: z.boolean().optional(),
  lockAfterInvoice: z.boolean().optional(),
  reminderRules: reminderRulesSchema.optional(),
  allowFutureEntries: z.boolean().optional(),
  expectedDailyHours: z.number().positive().max(24).optional().nullable(),
  expectedWeeklyHours: z.number().positive().max(168).optional().nullable(),
  submissionGraceDays: z.number().int().min(0).max(30).optional().nullable(),
  autoDraftFromAttendance: z.boolean().optional(),
  changeReason: z.string().max(500).optional(),
}).strict();
export type UpdateCoreSettingsInput = z.infer<typeof updateCoreSettingsSchema>;

export const settingsHistoryQuerySchema = z
  .object({
    limit: pageSizeField(50, 100),
  })
  .strict();
export type SettingsHistoryQuery = z.infer<typeof settingsHistoryQuerySchema>;
