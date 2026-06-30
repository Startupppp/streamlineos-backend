import { z } from "zod";

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
  digestMode: z.enum(["disabled", "hourly", "daily", "weekly"]).optional(),
  categories: z.record(z.string(), z.boolean()).optional(),
  channelCategories: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
});

export type UpdatePreferenceInput = z.infer<typeof updatePreferenceSchema>;
