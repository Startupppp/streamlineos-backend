import { z } from "zod";

export const updateNotificationPreferencesSchema = z.object({
  emailEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  inAppEnabled: z.boolean().optional(),
  quietHoursStart: z.string().nullable().optional(),
  quietHoursEnd: z.string().nullable().optional(),
  categories: z.record(z.string(), z.boolean()).optional(),
}).strict();

export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>;
