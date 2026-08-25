import { Controller, Headers, Param, Post, RawBodyRequest, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../../../common/auth/public.decorator";
import { BillingService } from "./billing.service";

@Public()
@Controller("webhooks/razorpay/:orgId")
export class RazorpayWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  async handle(
    @Param("orgId") orgId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-razorpay-signature") signature: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const rawBody = req.rawBody?.toString("utf8") ?? "";
    const result = await this.billing.handleRazorpayWebhook(orgId, rawBody, signature ?? "");
    res.status(result.status).json(result.body);
  }
}
