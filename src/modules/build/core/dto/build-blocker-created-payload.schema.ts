import { z } from "zod";

export const buildBlockerCreatedPayloadSchema = z.object({
  relationId: z.number().int().positive(),
  blockedTicketId: z.number().int().positive(),
  blockingTicketId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  orgId: z.string().min(1),
  actorUserId: z.string().min(1),
});

export type BuildBlockerCreatedPayload = z.infer<
  typeof buildBlockerCreatedPayloadSchema
>;
