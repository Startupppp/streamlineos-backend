import { Controller, Headers, Param, Post, RawBodyRequest, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../../../common/auth/public.decorator";
import { PaymentWebhookReceiverService } from "./payment-webhook-receiver.service";

@Public()
@Controller("webhooks/payments")
export class PaymentWebhooksPublicController {
  constructor(private readonly webhooks: PaymentWebhookReceiverService) {}

  @Post(":providerKey/:environment/:orgId")
  async handle(
    @Param("providerKey") providerKey: string,
    @Param("environment") environment: string,
    @Param("orgId") orgId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-payment-signature") paymentSignature: string | undefined,
    @Headers("x-payment-event-id") paymentEventId: string | undefined,
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
      // Keep the old Razorpay names as a compatibility fallback while all new providers use
      // the neutral headers. Provider-specific header aliases belong at this HTTP adapter seam.
      signature: paymentSignature ?? razorpaySignature,
      providerEventIdHeader: paymentEventId ?? razorpayEventId,
    });
    res.status(result.status).json(result.body);
  }
}
