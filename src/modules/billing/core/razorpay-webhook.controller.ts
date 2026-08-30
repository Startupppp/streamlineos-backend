import { Controller, Headers, Param, Post, RawBodyRequest, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { Public } from "../../../common/auth/public.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BillingService } from "./billing.service";

const orgIdParams = z.object({ orgId: z.string().min(1) }).strict();

@Public()
@Controller("webhooks/razorpay/:orgId")
export class RazorpayWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  @Validate({ params: orgIdParams })
  async handle(
    @Param("orgId") orgId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-razorpay-signature") signature: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const rawBody = req.rawBody?.toString("utf8") ?? "";
    // Keep the legacy URL/header contract while using the provider-neutral billing path.
    const result = await this.billing.handlePaymentProviderWebhook(
      orgId,
      "razorpay",
      rawBody,
      signature ?? "",
    );
    res.status(result.status).json(result.body);
  }
}
