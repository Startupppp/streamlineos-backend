import { Controller, Headers, Param, Post, RawBodyRequest, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../../../common/auth/public.decorator";
import { PaymentWebhookHealthService } from "./payment-webhook-health.service";

// Public, unauthenticated receiver — Razorpay/Stripe post here directly. Every request MUST
// have its signature verified before any DB write or business effect (see
// PaymentWebhookHealthService.processIncomingWebhook). orgId is embedded in the URL path so we
// know which tenant's webhook secret to verify against without trusting any request field.
@Public()
@Controller("webhooks/payments")
export class PaymentWebhooksPublicController {
  constructor(private readonly webhooks: PaymentWebhookHealthService) {}

  @Post(":providerKey/:environment/:orgId")
  async handle(
    @Param("providerKey") providerKey: string,
    @Param("environment") environment: string,
    @Param("orgId") orgId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-razorpay-signature") razorpaySignature: string | undefined,
    @Headers("x-razorpay-event-id") razorpayEventId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (environment !== "test" && environment !== "live") {
      res.status(400).json({ ok: false, error: "invalid environment" });
      return;
    }

    const rawBody = req.rawBody?.toString("utf8") ?? "";
    const result = await this.webhooks.processIncomingWebhook({
      providerKey,
      environment,
      orgId,
      rawBody,
      signature: razorpaySignature,
      providerEventIdHeader: razorpayEventId,
    });
    res.status(result.status).json(result.body);
  }
}
