import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

const webhookEndpointSafeSchema = z.object({
  id: z.number().int().positive(),
  orgId: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  events: z.array(z.string()),
  isActive: z.boolean(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const webhookListResponseSchema = z.object({
  data: z.array(webhookEndpointSafeSchema),
  pagination: z.object({
    limit: z.number().int().positive(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const webhookCreateResponseSchema = webhookEndpointSafeSchema.extend({
  secret: z.string(),
  secretHint: z.string(),
});

export const webhookRotateSecretResponseSchema = z.object({
  id: z.number().int().positive(),
  secret: z.string(),
  secretHint: z.string(),
});

export const webhookGetResponseSchema = webhookEndpointSafeSchema;

export const webhookUpdateResponseSchema = webhookEndpointSafeSchema;

export const webhookRemoveResponseSchema = z.object({ success: z.literal(true) });

const webhookLogSchema = z.object({
  id: z.number().int().positive(),
  endpointId: z.number().int().positive(),
  orgId: z.string(),
  event: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  statusCode: z.number().int().nullable(),
  responseBody: z.string().nullable(),
  attempt: z.number().int().positive(),
  success: z.boolean(),
  createdAt: wireDate(),
});

export const webhookListLogsResponseSchema = z.object({
  data: z.array(webhookLogSchema),
  pagination: z.object({
    limit: z.number().int().positive(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const webhookRetryLogResponseSchema = z.object({ success: z.boolean() });
