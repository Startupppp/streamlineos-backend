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
  inAppEnabled: z.boolean().optional(),
  slackEnabled: z.boolean().optional(),
  teamsEnabled: z.boolean().optional(),
  whatsappEnabled: z.boolean().optional(),
  soundEnabled: z.boolean().optional(),
  quietHoursStart: z.string().nullable().optional(),
  quietHoursEnd: z.string().nullable().optional(),
  quietHoursTimezone: z.string().optional(),
  quietHoursWeekends: z.boolean().optional(),
  allowCriticalOverride: z.boolean().optional(),
  digestMode: z.enum(["disabled", "hourly", "daily", "weekly"]).optional(),
  digestChannel: z.string().optional(),
  digestTime: z.string().nullable().optional(),
  categories: channelMap.optional(),
  channelCategories: z.record(z.string(), channelMap).optional(),
  eventPreferences: z.record(z.string(), eventPreferenceSchema).optional(),
  modulePreferences: z.record(z.string(), z.object({ mode: z.string().optional(), muted: z.boolean().optional() })).optional(),
  priorityPreferences: z.record(z.string(), z.object({ channels: channelMap.optional() })).optional(),
});

export type UpdatePreferenceInput = z.infer<typeof updatePreferenceSchema>;
export type EventPreferenceInput = z.infer<typeof eventPreferenceSchema>;
