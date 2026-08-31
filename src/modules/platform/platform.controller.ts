import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
  } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../../common/auth/public.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { PlatformService } from "./platform.service";
import { Validate } from "../../common/validation/validate.decorator";
import {
  visitSchema,
  contactFormSchema,
  type ContactFormInput,
  } from "./dto/platform.schemas";

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

@Controller("platform")
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Public()
  @Post("visit")
  @Validate({ body: visitSchema })
  async visit(@Req() req: Request, @Res() res: Response) {
    const forwardedFor = headerValue(req.headers["x-forwarded-for"]);
    const ip =
      forwardedFor?.split(",")[0]?.trim() ??
      headerValue(req.headers["x-real-ip"]) ??
      "unknown";

    const rl = await this.rateLimit.check("platform-visit", ip);
    if (!rl.allowed) {
      res.status(429).json({ ok: false });
      return;
    }

    const parsed = visitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false });
      return;
    }

    const userAgent = headerValue(req.headers["user-agent"])?.slice(0, 500) ?? null;
    const country = headerValue(req.headers["x-vercel-ip-country"]);

    await this.platform.recordVisit(parsed.data, { userAgent, country });
    res.status(200).json({ ok: true });
  }

  @Public()
  @Get("visit")
  @HttpCode(405)
  visitUsage() {
    return { usage: "POST { sessionToken, path, referrer }" };
  }

  @Public()
  @Post("contact")
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:contact")
  @Validate({ body: contactFormSchema })
  submitContact(
    @Body() body: ContactFormInput,
  ) {
    return this.platform.submitContactForm(body);
  }
}