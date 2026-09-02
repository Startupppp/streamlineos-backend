import { z } from "zod";

export const providerSyncPayloadSchema = z.object({
  userId: z.string(),
  title: z.string().optional(),
  description: z.string().nullish(),
  startIso: z.string().optional(),
  endIso: z.string().optional(),
  allDay: z.boolean().optional(),
  attendeeEmails: z.array(z.string()).optional(),
  addConference: z.boolean().optional(),
});

type ProviderSyncPayload = z.infer<typeof providerSyncPayloadSchema>;
