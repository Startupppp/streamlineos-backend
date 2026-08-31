import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { KbArticleAiService } from "./kb-article-ai.service";
import { kbAiAskBodySchema } from "../retrieval/dto/kb-ai.schemas";

const articleIdParams = z.object({ articleId: z.coerce.number().int().positive() }).strict();

@Controller("kb/articles/:articleId/ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@UseRateLimit("ai:invoke")
export class KbArticleAiController {
  constructor(private readonly svc: KbArticleAiService) {}

  @Post("summarize")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  async summarize(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.summarize(u, articleId);
  }

  @Post("ask")
  @HttpCode(200)
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams, body: kbAiAskBodySchema })
  async ask(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: { question: string },
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.ask(u, articleId, body.question);
  }

  @Post("improve")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  async improve(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.improve(u, articleId);
  }

  @Post("suggest-related")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  async suggestRelated(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.suggestRelated(u, articleId);
  }
}
