import { z } from "zod";

export const updateCoreSettingsSchema = z.object({
  workWeekStart: z.number().int().min(0).max(6).optional(),
  requiredFields: z.array(z.string()).optional(),
  roundingRule: z.string().optional(),
  maxHoursPerDay: z.number().positive().max(24).optional(),
  allowOverlappingEntries: z.boolean().optional(),
  allowBackdatedEntries: z.boolean().optional(),
  backdateLimitDays: z.number().int().positive().optional().nullable(),
  approvalMode: z.string().optional(),
  clientApprovalEnabled: z.boolean().optional(),
  lockAfterApproval: z.boolean().optional(),
  lockAfterInvoice: z.boolean().optional(),
  reminderRules: z.unknown().optional(),
});
export type UpdateCoreSettingsInput = z.infer<typeof updateCoreSettingsSchema>;
