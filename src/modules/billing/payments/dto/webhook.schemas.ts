import { z } from "zod";

// Razorpay's webhook envelope is the same shape across all event types: a top-level `event`
// name and a `payload` bag whose nested entity varies (payment.entity, refund.entity,
// subscription.entity, ...). We only need `event` + a redacted summary, not the full nested
// shape, so this stays intentionally loose rather than modeling every entity type.
export const webhookEnvelopeSchema = z.object({
  event: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  created_at: z.number().optional(),
});
export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

export const generateWebhookSchema = z.object({
  environment: z.enum(["test", "live"]),
});
export type GenerateWebhookInput = z.infer<typeof generateWebhookSchema>;

export const verifyWebhookSchema = z.object({
  environment: z.enum(["test", "live"]),
  rawBody: z.string().min(1).optional(),
  signature: z.string().min(1).optional(),
});
export type VerifyWebhookInput = z.infer<typeof verifyWebhookSchema>;
