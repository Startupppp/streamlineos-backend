import { Controller, Headers, Param, Post, RawBodyRequest, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../../../common/auth/public.decorator";
import { StripePlatformWebhookService } from "./stripe-webhook.service";

/**
 * Where Stripe posts, mirroring the Razorpay route it sits beside.
 *
 * `@Public()` because Stripe holds no session; the URL's `orgId` is the tenant
 * selector and the `stripe-signature` header is the authentication. The raw body
 * is read rather than the parsed one because Stripe signs the bytes -- a
 * re-serialised object differs by key order and whitespace and never verifies.
 */
@Public()
@Controller("webhooks/stripe/:orgId")
export class StripeWebhookController {
  constructor(private readonly webhooks: StripePlatformWebhookService) {}

  @Post()
  async handle(
    @Param("orgId") orgId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers("stripe-signature") signature: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const rawBody = req.rawBody?.toString("utf8") ?? "";
    const result = await this.webhooks.handle(orgId, rawBody, signature ?? "");
    res.status(result.status).json(result.body);
  }
}
