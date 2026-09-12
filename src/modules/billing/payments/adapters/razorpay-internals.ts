import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { OutboundRequestError } from "../../../../common/http/outbound-request";
import { ProviderCircuitBreaker } from "../../../../common/outbound/provider-circuit-breaker";
import type { FailureClass } from "../../../../common/outbound/call-provider";

export const razorpayOrderResponseSchema = z.object({
  id: z.string(),
  amount: z.number(),
  currency: z.string(),
});

export const razorpayOrderErrorSchema = z.object({
  error: z.object({ description: z.string().optional() }).optional(),
});

export const razorpayPaymentResponseSchema = z.object({
  id: z.string(),
  order_id: z.string().nullable(),
  status: z.enum(["created", "authorized", "captured", "refunded", "failed"]),
  amount: z.number(),
  currency: z.string(),
});

export function constantTimeEquals(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export class RazorpayServerError extends Error {
  constructor(description: string) {
    super(description);
    this.name = "RazorpayServerError";
  }
}

export class RazorpayClientError extends Error {
  constructor(description: string) {
    super(description);
    this.name = "RazorpayClientError";
  }
}

export function classifyRazorpayError(error: unknown): FailureClass {
  if (error instanceof RazorpayClientError) return "terminal";
  if (error instanceof OutboundRequestError) return "retryable";
  if (error instanceof RazorpayServerError) return "retryable";
  return "retryable";
}

export const razorpayBreaker = new ProviderCircuitBreaker();
