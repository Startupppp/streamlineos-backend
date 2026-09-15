import { Controller, Headers, Param, Post, RawBodyRequest, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { Public } from "../../../common/auth/public.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BillingWebhookHandler } from "./billing-webhook.handler";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";

const orgIdParams = z.object({ orgId: z.string().min(1) }).strict();

@Public()
@Controller("webhooks/razorpay/:orgId")
export class RazorpayWebhookController {
  constructor(private readonly webhookHandler: BillingWebhookHandler) {}

  @Post()
  @ApiOkResponse({ description: "Webhook received", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } } })
  @BodylessAction()
  @UseGuards(RateLimitGuard)
  @UseRateLimit("billing:webhook")
  @Validate({ params: orgIdParams })
  async handle(
    @Param("orgId") orgId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-razorpay-signature") signature: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const rawBody = req.rawBody?.toString("utf8") ?? "";
    // Keep the legacy URL/header contract while using the provider-neutral billing path.
    const result = await this.webhookHandler.handle(
      orgId,
      "razorpay",
      rawBody,
      signature ?? "",
    );
    res.status(result.status).json(result.body);
  }
}
