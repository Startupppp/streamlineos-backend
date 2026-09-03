import { z } from "zod";

export const updateCoreSettingsSchema = z.object({
  workWeekStart: z.number().int().min(0).max(6).optional(),
  requiredFields: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
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
  reminderRules: z.unknown().optional(),
  allowFutureEntries: z.boolean().optional(),
  expectedDailyHours: z.number().positive().max(24).optional().nullable(),
  expectedWeeklyHours: z.number().positive().max(168).optional().nullable(),
  submissionGraceDays: z.number().int().min(0).max(30).optional().nullable(),
  changeReason: z.string().max(500).optional(),
}).strict();
export type UpdateCoreSettingsInput = z.infer<typeof updateCoreSettingsSchema>;
