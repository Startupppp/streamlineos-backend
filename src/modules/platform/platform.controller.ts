import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { Request, Response } from "express";
import { Public } from "../../common/auth/public.decorator";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { bustPlatformAdminCache } from "../../common/auth/jwt-auth.guard";
import { PlatformService } from "./platform.service";
import {
  visitSchema,
  listMessagesQuerySchema,
  markStatusBodySchema,
  markRepliedBodySchema,
  replyMessageSchema,
  contactFormSchema,
  grantPlatformAdminSchema,
  type ContactFormInput,
  type GrantPlatformAdminInput,
} from "./dto/platform.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

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
  submitContact(
    @Body(new ZodValidationPipe(contactFormSchema)) body: ContactFormInput,
  ) {
    return this.platform.submitContactForm(body);
  }
}