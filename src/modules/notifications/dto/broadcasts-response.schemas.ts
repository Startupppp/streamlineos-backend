import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

const audienceSchema = z.object({
  type: z.enum(["all", "roles", "departments", "users"]),
  roleIds: z.array(z.string()).optional(),
  departmentIds: z.array(z.string()).optional(),
  userIds: z.array(z.string()).optional(),
});

export const broadcastRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  message: z.string(),
  type: z.string(),
  priority: z.string(),
  category: z.string(),
  channels: z.array(z.string()),
  audience: audienceSchema,
  audienceType: z.string(),
  status: z.string(),
  scheduledAt: nullableWireDate(),
  sentAt: nullableWireDate(),
  recipientCount: z.number().int(),
  deliveredCount: z.number().int(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const broadcastListResponseSchema = z.object({
  items: z.array(broadcastRowSchema),
  nextCursor: z.string().nullable(),
});

const inboxBroadcastSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  message: z.string(),
  type: z.string(),
  priority: z.string(),
  channels: z.array(z.string()),
  status: z.string(),
  createdAt: wireDate(),
});

export const broadcastInboxListSchema = z.object({
  items: z.array(inboxBroadcastSchema),
});

export const broadcastSuccessSchema = z.object({ success: z.literal(true) });

export const broadcastViewerCountSchema = z.object({
  broadcastId: z.number().int(),
  viewerCount: z.number().int(),
});
