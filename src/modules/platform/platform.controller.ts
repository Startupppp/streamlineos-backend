import {
  Body,
  Controller,
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
import type { Request, Response } from "express";
import { Public } from "../../common/auth/public.decorator";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { PlatformOwnerGuard } from "../../common/auth/platform-owner.guard";
import { PlatformService } from "./platform.service";
import {
  visitSchema,
  listMessagesQuerySchema,
  markStatusBodySchema,
  markRepliedBodySchema,
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

  @UseGuards(PlatformOwnerGuard)
  @Get("metrics")
  getDashboardMetrics() {
    return this.platform.getDashboardMetrics();
  }

  @UseGuards(PlatformOwnerGuard)
  @Get("customers")
  listCustomers() {
    return this.platform.listCustomers();
  }

  @UseGuards(PlatformOwnerGuard)
  @Get("customers/:slug")
  async getCustomerBySlug(@Param("slug") slug: string) {
    return this.platform.getCustomerBySlug(slug);
  }

  @UseGuards(PlatformOwnerGuard)
  @Get("messages")
  listMessages(@Query() query: Record<string, string>) {
    const parsed = listMessagesQuerySchema.safeParse(query);
    return this.platform.listMessages(parsed.success ? parsed.data : {});
  }

  @UseGuards(PlatformOwnerGuard)
  @Get("messages/:code")
  async getMessageByCode(@Param("code") code: string) {
    return this.platform.getMessageByPublicCode(code);
  }

  @UseGuards(PlatformOwnerGuard)
  @Patch("messages/:code/status")
  async updateMessageStatus(
    @Param("code") code: string,
    @Body() body: Record<string, unknown>,
  ) {
    const parsed = markStatusBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new NotFoundException("Invalid status");
    }
    return this.platform.updateMessageStatus(code, parsed.data.status);
  }

  @UseGuards(PlatformOwnerGuard)
  @Patch("messages/:code/replied")
  async markMessageReplied(
    @Param("code") code: string,
    @Body() body: Record<string, unknown>,
  ) {
    const parsed = markRepliedBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new NotFoundException("Invalid body");
    }
    return this.platform.markMessageReplied(code, parsed.data.repliedById, parsed.data.replyBody);
  }

  @UseGuards(PlatformOwnerGuard)
  @Get("leads")
  listLeads() {
    return this.platform.listLeads();
  }

  @UseGuards(PlatformOwnerGuard)
  @Get("revenue/payments")
  listPayments() {
    return this.platform.listPayments();
  }

  @UseGuards(PlatformOwnerGuard)
  @Get("revenue/summary")
  getRevenueSummary() {
    return this.platform.getRevenueSummary();
  }

  @UseGuards(PlatformOwnerGuard)
  @Get("visitors")
  getVisitorAnalytics() {
    return this.platform.getVisitorAnalytics();
  }

  @UseGuards(PlatformOwnerGuard)
  @Get("layout")
  getLayoutData(@Req() req: Request & { user?: CurrentUserContext }) {
    return this.platform.getLayoutData(req.user!.userId);
  }
}