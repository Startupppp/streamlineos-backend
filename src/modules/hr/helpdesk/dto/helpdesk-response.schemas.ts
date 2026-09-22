import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";
import { SUPPORT_QUEUES } from "../lib/support-queues";

const supportQueueWire = z.enum(SUPPORT_QUEUES);

export const hrHelpdeskCommentSchema = z.object({
  id: z.number().int(),
  ticketId: z.number().int(),
  orgId: z.string(),
  authorId: z.string(),
  authorMembershipId: z.number().int().nullable(),
  body: z.string(),
  createdAt: wireDate(),
  authorName: z.string().nullable(),
  authorImage: z.string().nullable(),
});

export const helpdeskTicketSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  queue: supportQueueWire,
  priority: z.string(),
  status: z.string(),
  assigneeId: z.string().nullable(),
  assigneeMembershipId: z.number().int().nullable(),
  assigneeName: z.string().nullable(),
  isConfidential: z.boolean(),
  firstResponseDueAt: nullableWireDate(),
  firstRespondedAt: nullableWireDate(),
  slaDueAt: nullableWireDate(),
  escalatedAt: nullableWireDate(),
  escalationLevel: z.number().int(),
  resolvedAt: nullableWireDate(),
  resolution: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  authorName: z.string().nullable(),
  authorImage: z.string().nullable(),
});

export const helpdeskTicketDetailSchema = helpdeskTicketSchema.extend({
  comments: z.array(hrHelpdeskCommentSchema),
});

export const helpdeskTicketListSchema = cursorPageSchema(helpdeskTicketSchema);

export const hrHelpdeskRoutingSchema = z.object({
  category: z.string(),
  queue: supportQueueWire,
  source: z.enum(["default", "org"]),
  ruleId: z.number().int().nullable(),
  assigneeUserId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  assigneeImage: z.string().nullable(),
});

export const helpdeskQueueSummarySchema = z.object({
  queue: supportQueueWire,
  label: z.string(),
  isMember: z.boolean(),
  source: z.enum(["default", "org"]),
  firstResponseHours: z.number().int(),
  resolutionHours: z.number().int(),
  escalationUserId: z.string().nullable(),
  escalationName: z.string().nullable(),
  openCount: z.number().int().nullable(),
  overdueCount: z.number().int().nullable(),
});

export const helpdeskSuggestSchema = z.object({
  results: z.array(
    z.object({
      id: z.number().int(),
      title: z.string(),
      slug: z.string(),
      excerpt: z.string().nullable(),
      source: z.string(),
    }),
  ),
});

export const hrCalendarEventSchema = z.object({
  id: z.string(),
  type: z.enum(["HOLIDAY", "LEAVE", "BIRTHDAY", "ANNIVERSARY", "REVIEW_CYCLE", "TRAVEL", "INTERVIEW"]),
  title: z.string(),
  date: z.string(),
  endDate: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export { successSchema };
