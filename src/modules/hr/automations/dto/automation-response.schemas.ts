import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export { successSchema };

const automationRuleRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  triggerEvent: z.string(),
  conditions: z.array(z.unknown()),
  actions: z.array(z.unknown()),
  isEnabled: z.boolean(),
  webhookSecret: z.string().nullable(),
  runCount: z.number().int(),
  lastRunAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

const automationRunRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  ruleId: z.number().int(),
  triggerEvent: z.string(),
  eventPayload: z.record(z.string(), z.unknown()).nullable(),
  status: z.string(),
  actionResults: z.array(z.unknown()).nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  triggeredByRunId: z.number().int().nullable(),
  depth: z.number().int(),
  createdAt: wireDate(),
});

const listResponseSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    totalPages: z.number().int(),
  });

export const automationRuleListSchema = listResponseSchema(automationRuleRowSchema);

export const automationRuleDetailSchema = automationRuleRowSchema;

export const automationRunListSchema = z.object({
  data: z.array(automationRunRowSchema),
  pagination: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

export const automationTestResultSchema = z.object({
  matched: z.boolean(),
  status: z.enum(["success", "partial", "failed", "skipped"]),
  matchedConditions: z.array(
    z.object({ condition: z.unknown(), matched: z.boolean() }),
  ),
  wouldRunActions: z.array(z.unknown()),
});

const automationEventItemSchema = z.object({
  value: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
  samplePayload: z.record(z.string(), z.unknown()).optional(),
});

export const automationEventsListSchema = z.object({
  events: z.array(automationEventItemSchema),
});

const webhookSubscriptionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  isActive: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const webhookSubscriptionListSchema = listResponseSchema(webhookSubscriptionRowSchema);

export const webhookSubscriptionDetailSchema = webhookSubscriptionRowSchema;

export const webhookSubscriptionCreateSchema = webhookSubscriptionRowSchema.extend({
  secret: z.string(),
});

const webhookDeliveryRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  subscriptionId: z.number().int(),
  event: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: z.string(),
  attempts: z.number().int(),
  lastAttemptAt: nullableWireDate(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  createdAt: wireDate(),
});

export const webhookDeliveryListSchema = listResponseSchema(webhookDeliveryRowSchema);

export const webhookTestResponseSchema = z.object({
  deliveryId: z.number().int(),
  event: z.string(),
});
