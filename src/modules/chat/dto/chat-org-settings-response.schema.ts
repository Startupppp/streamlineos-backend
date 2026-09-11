import { z } from "zod";

export const chatOrgSettingsResponseSchema = z
  .object({
    orgId: z.string().min(1),
    defaultNotificationPreference: z.enum(["ALL", "MENTIONS", "NOTHING"]),
    maxAttachmentSizeMb: z.number().int().min(1).max(1_000),
    maxHuddleParticipants: z.number().int().min(2).max(500),
  })
  .strict();

export type ChatOrgSettingsResponse = z.infer<typeof chatOrgSettingsResponseSchema>;
