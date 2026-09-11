import { Controller, Headers, Param, Post, RawBodyRequest, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { Public } from "../../../common/auth/public.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import { StripePlatformWebhookService } from "./stripe-webhook.service";

const orgIdParams = z.object({ orgId: z.string().min(1) }).strict();

/**
 * Where Stripe posts, mirroring the Razorpay route it sits beside.
 *
 * `@Public()` because Stripe holds no session; the URL's `orgId` is the tenant
 * selector and the `stripe-signature` header is the authentication. The raw body
 * is read rather than the parsed one because Stripe signs the bytes -- a
 * re-serialised object differs by key order and whitespace and never verifies.
 *
 * The signature is the only thing that says a delivery is genuine, and checking
 * it costs an HMAC over the body -- so an unauthenticated caller can spend that
 * as fast as it can post. `billing:webhook` is the same 600/60 the Razorpay
 * route and the tenant-facing receiver carry, for the same reason.
 */
@Public()
@Controller("webhooks/stripe/:orgId")
export class StripeWebhookController {
  constructor(private readonly webhooks: StripePlatformWebhookService) {}

  @Post()
  @ApiOkResponse({ description: "Webhook received", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } } })
  @BodylessAction()
  @UseGuards(RateLimitGuard)
  @UseRateLimit("billing:webhook")
  @Validate({ params: orgIdParams })
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
