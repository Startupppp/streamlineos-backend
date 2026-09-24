import { z } from "zod";
import { RECRUITMENT_EVENTS } from "../recruitment-webhook-events";

export const replayBodySchema = z
  .object({ event: z.enum(RECRUITMENT_EVENTS) })
  .strict();

export type ReplayBodyInput = z.infer<typeof replayBodySchema>;

export const subscriptionIdParams = z
  .object({ subscriptionId: z.coerce.number().int().positive() })
  .strict();

export const deliveryParams = z
  .object({
    subscriptionId: z.coerce.number().int().positive(),
    deliveryId: z.coerce.number().int().positive(),
  })
  .strict();

export const recentDeliveriesQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();

export type RecentDeliveriesQuery = z.infer<typeof recentDeliveriesQuery>;

const fieldDocSchema = z.object({
  field: z.string(),
  label: z.string(),
  type: z.enum(["string", "number", "boolean", "date"]).optional(),
});

export const catalogueSchema = z.object({
  signatureHeader: z.string(),
  eventHeader: z.string(),
  timestampHeader: z.string(),
  algorithm: z.string(),
  events: z.array(
    z.object({
      value: z.string(),
      fields: z.array(fieldDocSchema),
      samplePayload: z.record(z.string(), z.unknown()),
      exampleSecret: z.string(),
      exampleBody: z.string(),
      exampleSignature: z.string(),
    }),
  ),
});

export const replayResultSchema = z.object({
  deliveryId: z.number().int(),
  event: z.string(),
  queued: z.boolean(),
  note: z.string(),
});

export const signatureViewSchema = z.object({
  deliveryId: z.number().int(),
  event: z.string(),
  status: z.string(),
  attempts: z.number().int(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  signedBody: z.string(),
  signature: z.string(),
  caveat: z.string(),
});

export const recentDeliveryListSchema = z.array(
  z.object({
    deliveryId: z.number().int(),
    subscriptionId: z.number().int(),
    subscriptionName: z.string(),
    event: z.string(),
    status: z.string(),
    attempts: z.number().int(),
    responseStatus: z.number().int().nullable(),
    error: z.string().nullable(),
    createdAt: z.coerce.date(),
  }),
);

export const directorySyncSchema = z.array(
  z.object({
    capability: z.enum(["SSO", "SCIM"]),
    provider: z.object({
      provider: z.string(),
      status: z.literal("BLOCKED"),
      code: z.string(),
      message: z.string(),
    }),
    availableToday: z.string(),
  }),
);
