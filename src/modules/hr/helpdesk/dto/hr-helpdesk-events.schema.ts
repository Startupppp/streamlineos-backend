import { z } from "zod";
import { SUPPORT_QUEUES } from "../lib/support-queues";

export const helpdeskTicketCreatedPayloadSchema = z.object({
  ticketId: z.number().int().positive(),
  orgId: z.string().min(1),
  creatorId: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  queue: z.enum(SUPPORT_QUEUES),
  priority: z.string().min(1),
  isConfidential: z.boolean(),
});

export const helpdeskTicketAssignedPayloadSchema = z.object({
  ticketId: z.number().int().positive(),
  orgId: z.string().min(1),
  actorId: z.string().min(1),
  assigneeId: z.string().min(1),
  title: z.string().min(1),
});

export const helpdeskTicketStatusChangedPayloadSchema = z.object({
  ticketId: z.number().int().positive(),
  orgId: z.string().min(1),
  actorId: z.string().min(1),
  newStatus: z.string().min(1),
  title: z.string().min(1),
  ownerId: z.string().min(1),
});

type HelpdeskTicketCreatedPayload = z.infer<typeof helpdeskTicketCreatedPayloadSchema>;
type HelpdeskTicketAssignedPayload = z.infer<typeof helpdeskTicketAssignedPayloadSchema>;
type HelpdeskTicketStatusChangedPayload = z.infer<typeof helpdeskTicketStatusChangedPayloadSchema>;
