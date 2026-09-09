import { z } from "zod";
import { reminderRulesSchema } from "./reminder-rules.schemas";

export const updateCoreSettingsSchema = z.object({
  workWeekStart: z.number().int().min(0).max(6).optional(),
  requiredFields: z.array(z.string()).optional(),
  roundingRule: z
    .enum([
      "NONE",
      "NEAREST_5",
      "NEAREST_6",
      "NEAREST_10",
      "NEAREST_15",
      "ROUND_UP",
      "ROUND_DOWN",
    ])
    .optional(),
  maxHoursPerDay: z.number().positive().max(24).optional(),
  allowOverlappingEntries: z.boolean().optional(),
  allowBackdatedEntries: z.boolean().optional(),
  backdateLimitDays: z.number().int().positive().optional().nullable(),
  approvalMode: z.enum(["MANAGER", "AUTO", "MULTI_LEVEL"]).optional(),
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
  changeReason: z.string().max(500).optional(),
});
export type UpdateCoreSettingsInput = z.infer<typeof updateCoreSettingsSchema>;
