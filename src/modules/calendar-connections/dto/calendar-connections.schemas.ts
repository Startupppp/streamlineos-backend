import { z } from "zod";

export const upsertConnectionSchema = z.object({
  provider: z.enum(["GOOGLE", "MICROSOFT"]),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresIn: z.number().int().optional(),
  providerEmail: z.string().email(),
});

export const freeBusySchema = z.object({
  timeMin: z.string().datetime(),
  timeMax: z.string().datetime(),
});

export const createEventSchema = z.object({
  summary: z.string(),
  startDateTime: z.string().datetime(),
  endDateTime: z.string().datetime(),
  description: z.string().optional(),
  attendeeEmails: z.array(z.string().email()).default([]),
  location: z.string().optional(),
  conferenceLink: z.string().optional(),
});

export type UpsertConnectionInput = z.infer<typeof upsertConnectionSchema>;
export type FreeBusyInput = z.infer<typeof freeBusySchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
