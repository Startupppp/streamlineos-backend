import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const portalTicketSummarySchema = z.object({
  id: z.number().int(),
  title: z.string(),
  category: z.string().nullable(),
  status: z.enum(["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"]),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  resolvedAt: nullableWireDate(),
  closedAt: nullableWireDate(),
});

export const portalTicketListSchema = z.array(portalTicketSummarySchema);

export const portalMessageSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  ticketId: z.number().int(),
  authorId: z.string().nullable(),
  body: z.string(),
  isInternal: z.boolean(),
  sourceChannel: z.string(),
  sourceMessageId: z.string().nullable(),
  sourceContactEmail: z.string().nullable(),
  sourceContactName: z.string().nullable(),
  createdAt: wireDate(),
});

export const portalTicketDetailSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  status: z.enum(["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"]),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  resolvedAt: nullableWireDate(),
  closedAt: nullableWireDate(),
  messages: z.array(portalMessageSchema),
});

export const supportCustomFieldShapeSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  key: z.string(),
  label: z.string(),
  fieldType: z.string(),
  options: z.array(z.string()).nullable(),
  required: z.boolean(),
  category: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const portalCustomFieldListSchema = z.array(supportCustomFieldShapeSchema);

export const portalCreateTicketSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  clientId: z.number().int().nullable(),
  assigneeMembershipId: z.number().int().nullable(),
  title: z.string(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  requesterEmail: z.string().nullable(),
  requesterName: z.string().nullable(),
  status: z.enum(["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"]),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  slaDeadline: nullableWireDate(),
  firstResponseDueAt: nullableWireDate(),
  firstRespondedAt: nullableWireDate(),
  slaPausedAt: nullableWireDate(),
  slaPausedMinutes: z.number().int(),
  slaEscalationLevel: z.number().int(),
  resolvedAt: nullableWireDate(),
  closedAt: nullableWireDate(),
  queueId: z.number().int().nullable(),
  mergedIntoTicketId: z.number().int().nullable(),
  snoozedUntil: nullableWireDate(),
  snoozedBy: z.string().nullable(),
  createdByMembershipId: z.number().int(),
  sourceChannel: z.string(),
  sourceMessageId: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  possibleDuplicateOf: z.object({ id: z.number().int(), title: z.string() }).nullable(),
});

export { successSchema };
