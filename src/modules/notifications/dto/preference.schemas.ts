import { z } from "zod";

const channelMap = z.record(z.string(), z.boolean());

export const eventPreferenceSchema = z.object({
  channels: channelMap.optional(),
  muted: z.boolean().optional(),
  mode: z.string().optional(),
});

export const updatePreferenceSchema = z.object({
  emailEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  whatsappEnabled: z.boolean().optional(),
  inAppEnabled: z.boolean().optional(),
  soundEnabled: z.boolean().optional(),
  quietHoursStart: z.string().nullable().optional(),
  quietHoursEnd: z.string().nullable().optional(),
  quietHoursWeekends: z.boolean().optional(),
  allowCriticalOverride: z.boolean().optional(),
  digestMode: z.enum(["disabled", "hourly", "daily", "weekly"]).optional(),
  categories: channelMap.optional(),
  channelCategories: z.record(z.string(), channelMap).optional(),
  eventPreferences: z.record(z.string(), eventPreferenceSchema).optional(),
  modulePreferences: z.record(z.string(), z.object({ mode: z.string().optional(), muted: z.boolean().optional() })).optional(),
});

const SUPPRESSION_CHANNELS = ["IN_APP", "EMAIL", "PUSH", "SMS", "WHATSAPP", "WEBHOOK"] as const;

export const createSuppressionSchema = z.object({
  scopeType: z.enum(["event", "module", "category"]),
  scopeKey: z.string().min(1).max(200),
  channel: z.enum(SUPPRESSION_CHANNELS).optional(),
  expiresAt: z.string().datetime().optional(),
});

export type UpdatePreferenceInput = z.infer<typeof updatePreferenceSchema>;
export type EventPreferenceInput = z.infer<typeof eventPreferenceSchema>;
export type CreateSuppressionInput = z.infer<typeof createSuppressionSchema>;
