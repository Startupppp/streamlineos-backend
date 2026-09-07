import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

const webhookSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  isActive: z.boolean(),
  lastDeliveryAt: wireDate().nullable(),
  lastDeliveryStatus: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listWebhooksResponseSchema = z.array(webhookSchema);

export const webhookResponseSchema = webhookSchema;

const webhookEventSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  webhookId: z.number().int().nullable(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: z.string(),
  attempts: z.number().int(),
  deliveredAt: wireDate().nullable(),
  createdAt: wireDate(),
});

export const listWebhookEventsResponseSchema = itemsPagedSchema(webhookEventSchema);

export const retryEventResponseSchema = webhookEventSchema;

export const deleteWebhookResponseSchema = z.object({ deleted: z.literal(true) });
