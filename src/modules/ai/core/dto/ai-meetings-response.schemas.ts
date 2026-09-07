import { z } from "zod";
import { agendaOutputSchema, followUpOutputSchema } from "./meetings-output.schemas";

export const meetingsPrepResponseSchema = z.object({
  agenda: agendaOutputSchema,
  connectedIntegrations: z.boolean(),
});

export const meetingsFollowUpResponseSchema = z.object({
  followUp: followUpOutputSchema,
  eventTitle: z.string(),
});

export const proposeSendFollowUpResponseSchema = z.object({
  proposalId: z.number().int(),
  token: z.string(),
  expiresAt: z.string(),
});

export const confirmSendFollowUpResponseSchema = z.union([
  z.object({ executed: z.literal(true), channel: z.string() }),
  z.object({ executed: z.literal(false), error: z.string(), message: z.string() }),
]);
