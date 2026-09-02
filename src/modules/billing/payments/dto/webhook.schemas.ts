import { z } from "zod";

// Provider adapters parse their own envelope and emit this small, provider-neutral contract.
// Billing must not learn provider field names such as Razorpay's `order_id`.
export const webhookEnvelopeSchema = z.object({
  event: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  created_at: z.number().optional(),
});

export const paymentWebhookPaymentSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().optional(),
  amount: z.number(),
  fee: z.number().optional(),
  currency: z.string(),
  status: z.string(),
  method: z.string().optional(),
  email: z.string().optional(),
  description: z.string().optional(),
  notes: z.record(z.string(), z.string()).optional(),
  invoiceId: z.string().optional(),
  createdAt: z.number().optional(),
});

export const normalizedPaymentWebhookEventSchema = z.object({
  event: z.string(),
  payload: z.object({
    payment: z.object({ entity: paymentWebhookPaymentSchema }).optional(),
  }),
});

export type PaymentWebhookPayment = z.infer<typeof paymentWebhookPaymentSchema>;
export type NormalizedPaymentWebhookEvent = z.infer<typeof normalizedPaymentWebhookEventSchema>;

export const generateWebhookSchema = z.object({
  environment: z.enum(["test", "live"]),
}).strict();
export type GenerateWebhookInput = z.infer<typeof generateWebhookSchema>;

export const verifyWebhookSchema = z.object({
  environment: z.enum(["test", "live"]),
  rawBody: z.string().min(1).optional(),
  signature: z.string().min(1).optional(),
}).strict();
export type VerifyWebhookInput = z.infer<typeof verifyWebhookSchema>;
