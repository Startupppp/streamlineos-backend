import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

const auditLogItemSchema = z.object({
  id: z.string(),
  action: z.string(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
  userImage: z.string().nullable(),
  targetId: z.string().nullable(),
  targetType: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
  createdAt: wireDate(),
});

const auditLogPaginationSchema = z.object({
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const auditLogListSchema = z.object({
  logs: z.array(auditLogItemSchema),
  pagination: auditLogPaginationSchema,
});

export const auditLogActionsSchema = z.array(z.string());

export const auditLogTargetTypesSchema = z.array(z.string());
