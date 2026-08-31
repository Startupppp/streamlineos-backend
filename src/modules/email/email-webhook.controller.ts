import {
  BadRequestException,
  Controller,
  HttpException,
  Param,
  Post,
  RawBodyRequest,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../../common/auth/public.decorator";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { EmailWebhookService, type EmailWebhookProvider } from "./email-webhook.service";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const providerParams = z.object({ provider: z.string().min(1) }).strict();

const PROVIDERS: readonly EmailWebhookProvider[] = ["resend", "zeptomail"];

function isProvider(value: string): value is EmailWebhookProvider {
  return PROVIDERS.some((p) => p === value);
}

/**
 * SEC-002. Bounce and complaint receiver. `@Public()` because providers cannot
 * carry a session — authentication is the per-provider signature check, verified
 * before anything is parsed or written.
 */
@Public()
@Controller("webhooks/email")
export class EmailWebhookController {
  constructor(
    private readonly webhooks: EmailWebhookService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post(":provider")
  @BodylessAction()
  @Validate({ params: providerParams })
  async handle(
    @Param("provider") provider: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    if (!isProvider(provider)) throw new BadRequestException("Unknown email webhook provider");

    // The "webhook:email" tier must exist in TIERS or check() returns allowed for
    // an unknown key and this guard silently does nothing.
    const limit = await this.rateLimit.check("webhook:email", req.ip ?? "unknown");
    if (!limit.allowed) throw new HttpException("Too many requests", 429);

    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers))
      headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;

    const result = await this.webhooks.handle({
      provider,
      rawBody: req.rawBody?.toString("utf8") ?? "",
      headers,
    });
    res.status(result.status).json(result.body);
  }
}
