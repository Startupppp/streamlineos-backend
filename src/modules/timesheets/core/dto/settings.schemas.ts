import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { reminderRulesSchema } from "./reminder-rules.schemas";
import { timesheetApprovalModeSchema, timesheetRoundingRuleSchema } from "./status.schemas";

export const updateCoreSettingsSchema = z.object({
  workWeekStart: z.number().int().min(0).max(6).optional(),
  requiredFields: z.array(z.string()).optional(),
  roundingRule: timesheetRoundingRuleSchema.optional(),
  maxHoursPerDay: z.number().positive().max(24).optional(),
  allowOverlappingEntries: z.boolean().optional(),
  allowBackdatedEntries: z.boolean().optional(),
  backdateLimitDays: z.number().int().positive().optional().nullable(),
  approvalMode: timesheetApprovalModeSchema.optional(),
  clientApprovalEnabled: z.boolean().optional(),
  lockAfterApproval: z.boolean().optional(),
  lockAfterInvoice: z.boolean().optional(),
  /**
   * Was `z.unknown()`, which combined with `updateSettings` copying every
   * defined field straight through made this column an open JSON sink that
   * nothing read. Now parsed, so a typo'd key is rejected at the edge rather
   * than stored and silently ignored.
   */
  reminderRules: reminderRulesSchema.optional(),
  allowFutureEntries: z.boolean().optional(),
  expectedDailyHours: z.number().positive().max(24).optional().nullable(),
  expectedWeeklyHours: z.number().positive().max(168).optional().nullable(),
  submissionGraceDays: z.number().int().min(0).max(30).optional().nullable(),
  /**
   * TS-09. Without this the column added by migration 0659 would be
   * unreachable: `updateSettings` copies only fields the schema admits, so a
   * policy flag missing from the DTO is a flag nobody can turn on.
   */
  autoDraftFromAttendance: z.boolean().optional(),
  /**
   * TS-16. Optional here and required in the service, because whether it is
   * required depends on what else is in the payload — a change to
   * `reminderRules` alone needs no justification, a change to
   * `maxHoursPerDay` does. A schema cannot see the stored values it would have
   * to compare against, so the rule lives where the comparison happens.
   */
  changeReason: z.string().max(500).optional(),
});
export type UpdateCoreSettingsInput = z.infer<typeof updateCoreSettingsSchema>;

/** TS-34. The settings history list, bounded like every other list endpoint. */
export const settingsHistoryQuerySchema = z
  .object({
    limit: pageSizeField(50, 100),
  })
  .strict();
export type SettingsHistoryQuery = z.infer<typeof settingsHistoryQuerySchema>;
