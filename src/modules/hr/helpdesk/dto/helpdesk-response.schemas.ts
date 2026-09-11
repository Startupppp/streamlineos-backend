import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";

export const hrHelpdeskCommentSchema = z.object({
  id: z.number().int(),
  ticketId: z.number().int(),
  orgId: z.string(),
  authorId: z.string(),
  authorMembershipId: z.number().int().nullable(),
  body: z.string(),
  createdAt: wireDate(),
});

export const helpdeskTicketSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  priority: z.string(),
  status: z.string(),
  assigneeId: z.string().nullable(),
  assigneeMembershipId: z.number().int().nullable(),
  isConfidential: z.boolean(),
  slaDueAt: nullableWireDate(),
  resolvedAt: nullableWireDate(),
  resolution: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const helpdeskTicketDetailSchema = helpdeskTicketSchema.extend({
  comments: z.array(hrHelpdeskCommentSchema),
});

export const helpdeskTicketListSchema = cursorPageSchema(helpdeskTicketSchema);

export const hrHelpdeskRoutingSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  category: z.string(),
  assigneeUserId: z.string(),
  assigneeMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
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
