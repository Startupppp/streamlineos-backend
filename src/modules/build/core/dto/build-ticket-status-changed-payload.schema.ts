import { z } from "zod";

export const buildTicketStatusChangedPayloadSchema = z.object({
  ticketId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  orgId: z.string().min(1),
  previousStatus: z.string().min(1),
  newStatus: z.string().min(1),
  actorUserId: z.string().min(1),
});

type BuildTicketStatusChangedPayload = z.infer<
  typeof buildTicketStatusChangedPayloadSchema
>;
