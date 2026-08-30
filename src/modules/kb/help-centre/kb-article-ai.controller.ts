import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { KbArticleAiService } from "./kb-article-ai.service";
import { kbAiAskBodySchema, type KbAiAskBodyInput } from "../retrieval/dto/kb-ai.schemas";

@Controller("kb/articles/:articleId/ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@UseRateLimit("ai:invoke")
export class KbArticleAiController {
  constructor(private readonly svc: KbArticleAiService) {}

  @Post("summarize")
  @HttpCode(200)
  @RequirePermission("kb:articles:view")
  async summarize(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.summarize(u, articleId);
  }

  @Post("ask")
  @HttpCode(200)
  @RequirePermission("kb:articles:view")
  async ask(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(kbAiAskBodySchema)) body: KbAiAskBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.ask(u, articleId, body.question);
  }

  @Post("improve")
  @HttpCode(200)
  @RequirePermission("kb:articles:view")
  async improve(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.improve(u, articleId);
  }

  @Post("suggest-related")
  @HttpCode(200)
  @RequirePermission("kb:articles:view")
  async suggestRelated(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.suggestRelated(u, articleId);
  }
}
