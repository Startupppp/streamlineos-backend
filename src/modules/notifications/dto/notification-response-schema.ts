import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

const timestamp = z.union([wireDate(), z.iso.datetime()]);
const nullableText = z.string().nullable();
const ticketContext = z.object({
  ticketId: z.number().int(),
  ticketKey: z.string(),
  priority: nullableText,
  status: nullableText,
  type: nullableText,
  assignee: z.object({
    id: z.string(),
    name: nullableText,
    firstName: nullableText,
    lastName: nullableText,
    image: nullableText,
  }).strict().nullable(),
}).strict();

export const notificationListResponseSchema = z.object({
  data: z.array(z.object({
    id: z.number().int(),
    orgId: z.string(),
    userId: nullableText,
    type: z.string(),
    priority: z.string(),
    category: z.string(),
    sourceModule: nullableText,
    eventKey: nullableText,
    entityType: nullableText,
    entityId: nullableText,
    reason: nullableText,
    title: z.string(),
    message: z.string(),
    link: nullableText,
    isRead: z.boolean(),
    pinned: z.boolean(),
    channel: z.string(),
    metadata: z.record(z.string(), z.json()).nullable(),
    archivedAt: timestamp.nullable(),
    snoozedUntil: timestamp.nullable(),
    createdAt: timestamp,
    ticketContext: ticketContext.nullable(),
  }).strict()).max(100),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nullable(),
}).strict();

export const notificationCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
}).strict();

export const notificationSuccessResponseSchema = z.object({
  success: z.literal(true),
}).strict();

export const notificationStreamTokenResponseSchema = z.object({
  token: z.string().min(1),
}).strict();
