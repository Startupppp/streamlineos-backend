import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { KbPageAiService } from "./kb-page-ai.service";
import { kbAiAskBodySchema } from "./dto/kb-ai.schemas";

@Controller("kb/pages/:pageId/ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@UseRateLimit("ai:invoke")
export class KbPageAiController {
  constructor(private readonly svc: KbPageAiService) {}

  @Post("summarize")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  async summarize(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.summarize(u, pageId);
  }

  @Post("ask")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  async ask(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const parsed = kbAiAskBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.svc.ask(u, pageId, parsed.data.question);
  }

  @Post("improve")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  async improve(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.improve(u, pageId);
  }

  @Post("suggest-related")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  async suggestRelated(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.suggestRelated(u, pageId);
  }
}
