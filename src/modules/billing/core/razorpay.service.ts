import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  razorpayOrderErrorSchema,
  razorpayOrderSchema,
  type RazorpayOrder,
} from "./dto/billing.schemas";

interface CreateOrderParams {
  amount: number;
  receipt: string;
  notes: Record<string, string>;
}

@Injectable()
export class RazorpayService {
  private get keyId(): string | undefined {
    return process.env.RAZORPAY_KEY_ID;
  }

  private get keySecret(): string | undefined {
    return process.env.RAZORPAY_KEY_SECRET;
  }

  private get webhookSecret(): string | undefined {
    return process.env.RAZORPAY_WEBHOOK_SECRET;
  }

  isConfigured(): boolean {
    return Boolean(this.keyId && this.keySecret);
  }

  getKeyId(): string | null {
    return this.keyId ?? null;
  }

  async createOrder(params: CreateOrderParams): Promise<RazorpayOrder> {
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64");
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: params.amount,
        currency: "INR",
        receipt: params.receipt,
        notes: params.notes,
      }),
    });

    if (!response.ok) {
      const raw: unknown = await response.json().catch(() => ({}));
      const parsed = razorpayOrderErrorSchema.safeParse(raw);
      const description = parsed.success
        ? parsed.data.error?.description ?? "Unknown error"
        : "Unknown error";
      throw new HttpException(
        `Razorpay order creation failed: ${description}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const data: unknown = await response.json();
    return razorpayOrderSchema.parse(data);
  }

  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    const secret = this.keySecret;
    if (!secret) return false;
    const expected = createHmac("sha256", secret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    return this.constantTimeEquals(expected, signature);
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const secret = this.webhookSecret;
    if (!secret) return false;
    try {
      const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
      return this.constantTimeEquals(expected, signature);
    } catch {
      return false;
    }
  }

  private constantTimeEquals(expected: string, provided: string): boolean {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}
