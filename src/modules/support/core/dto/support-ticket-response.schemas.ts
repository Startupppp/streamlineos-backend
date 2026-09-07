import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

const userMinimalSchema = z.object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() });
const userNoImageSchema = z.object({ id: z.string(), name: z.string().nullable() });
const membershipMinimalSchema = z.object({ id: z.number().int(), user: userMinimalSchema.nullable() });
const membershipNoImageSchema = z.object({ id: z.number().int(), user: userNoImageSchema.nullable() });
const clientMinimalSchema = z.object({ id: z.number().int(), name: z.string() });

export const supportTicketRowSchema = z.object({
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
});

const ticketWithRelationsSchema = supportTicketRowSchema.and(
  z.object({
    client: clientMinimalSchema.nullable(),
    assigneeMembership: membershipMinimalSchema.nullable(),
    creatorMembership: membershipNoImageSchema.nullable(),
  }),
);

export const supportTicketListSchema = z.object({
  items: z.array(ticketWithRelationsSchema),
  total: z.number().int(),
  page: z.number().int(),
  totalPages: z.number().int(),
});

export const supportTicketMessageRowSchema = z.object({
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

export const supportTicketMessageWithAuthorSchema = supportTicketMessageRowSchema.and(
  z.object({ author: userMinimalSchema.nullable() }),
);

export const supportTicketDetailSchema = ticketWithRelationsSchema.and(
  z.object({
    messages: z.array(supportTicketMessageWithAuthorSchema),
    customFieldValues: z.array(
      z.object({ fieldId: z.number().int(), key: z.string(), value: z.string().nullable() }),
    ),
  }),
);

export const createTicketResultSchema = supportTicketRowSchema.and(
  z.object({
    possibleDuplicateOf: z.object({ id: z.number().int(), title: z.string() }).nullable(),
  }),
);

export const ticketStatsSchema = z.object({
  open: z.number().int(),
  in_progress: z.number().int(),
  waiting: z.number().int(),
  resolved: z.number().int(),
  closed: z.number().int(),
  sla_breached: z.number().int(),
});

export const supportTicketMessageListSchema = z.array(supportTicketMessageWithAuthorSchema);

export const supportTicketActivityRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  supportTicketId: z.number().int(),
  userId: z.string().nullable(),
  action: z.enum([
    "created", "status_changed", "priority_changed", "assignee_changed",
    "replied", "internal_note", "resolved", "reopened", "merged", "linked",
    "split", "snoozed", "unsnoozed",
  ]),
  fromValue: z.string().nullable(),
  toValue: z.string().nullable(),
  createdAt: wireDate(),
});

export const supportTicketActivityListSchema = z.array(supportTicketActivityRowSchema);

export const supportTicketLinkRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  ticketId: z.number().int(),
  linkedTicketId: z.number().int(),
  relation: z.enum(["duplicate", "related", "split"]),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  linkedTicket: z.object({ id: z.number().int(), title: z.string(), status: z.string() }).nullable(),
});

export const supportTicketLinkListSchema = z.array(supportTicketLinkRowSchema);

export const addTicketLinkResultSchema = z.union([
  supportTicketLinkRowSchema,
  successSchema,
]);

export const mergeTicketResultSchema = z.object({
  success: z.literal(true),
  mergedIntoTicketId: z.number().int(),
});

export const snoozeTicketResultSchema = z.object({
  success: z.literal(true),
  snoozedUntil: wireDate(),
});

export const supportTicketDraftSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  ticketId: z.number().int(),
  userMembershipId: z.number().int(),
  body: z.string(),
  isInternal: z.boolean(),
  updatedAt: wireDate(),
});

export const supportTicketExternalLinkRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  ticketId: z.number().int(),
  entityType: z.enum(["project", "invoice", "calendar_event", "chat_channel"]),
  entityId: z.number().int(),
  label: z.string(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const supportTicketExternalLinkListSchema = z.array(supportTicketExternalLinkRowSchema);

export const addExternalLinkResultSchema = z.union([
  supportTicketExternalLinkRowSchema,
  successSchema,
]);

export const updateTicketResultSchema = z.object({
  success: z.literal(true),
  updatedAt: wireDate(),
});

export { successSchema };
