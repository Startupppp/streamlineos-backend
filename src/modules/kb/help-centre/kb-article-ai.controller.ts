import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { z } from "zod";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { NoTenantTransaction } from "../../../common/tenant/no-tenant-transaction.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import { kbAiBufferedSchema } from "./dto/kb-helpcenter-response.schemas";
import { AiRequestAbortInterceptor, respondWithAiTextStream } from "../../ai/core/streaming";
import { KbArticleAiService } from "./kb-article-ai.service";
import { kbAiAskBodySchema, type KbDocAiAction } from "../retrieval/dto/kb-ai.schemas";

const articleIdParams = z.object({ articleId: z.coerce.number().int().positive() }).strict();

@Controller("kb/articles/:articleId/ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@UseRateLimit("ai:invoke")
@UseInterceptors(AiRequestAbortInterceptor)
export class KbArticleAiController {
  constructor(private readonly svc: KbArticleAiService) {}

  private streamAction(
    req: Request,
    res: Response,
    u: CurrentUserContext,
    articleId: number,
    action: KbDocAiAction,
    question?: string,
  ): Promise<void> {
    return respondWithAiTextStream(
      req,
      res,
      {
        feature: `kb.article-${action}`,
        orgId: u.orgId,
        route: `POST /kb/articles/:articleId/ai/${action}/stream`,
      },
      (signal) => this.svc.stream(u, articleId, action, question, signal),
    );
  }

  @Post("summarize")
  @BodylessAction()
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  @ResponseSchema(kbAiBufferedSchema)
  async summarize(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.summarize(u, articleId);
  }

  @Post("summarize/stream")
  @BodylessAction()
  @NoTenantTransaction()
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  @ApiOkResponse({ schema: { type: "string" } })
  async summarizeStream(
    @Req() req: Request,
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    return this.streamAction(req, res, u, articleId, "summarize");
  }

  @Post("ask")
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams, body: kbAiAskBodySchema })
  @ResponseSchema(kbAiBufferedSchema)
  async ask(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: z.infer<typeof kbAiAskBodySchema>,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.ask(u, articleId, body.question);
  }

  @Post("ask/stream")
  @NoTenantTransaction()
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams, body: kbAiAskBodySchema })
  @ApiOkResponse({ schema: { type: "string" } })
  async askStream(
    @Req() req: Request,
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: z.infer<typeof kbAiAskBodySchema>,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    return this.streamAction(req, res, u, articleId, "ask", body.question);
  }

  @Post("improve")
  @BodylessAction()
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  @ResponseSchema(kbAiBufferedSchema)
  async improve(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.improve(u, articleId);
  }

  @Post("improve/stream")
  @BodylessAction()
  @NoTenantTransaction()
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  @ApiOkResponse({ schema: { type: "string" } })
  async improveStream(
    @Req() req: Request,
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    return this.streamAction(req, res, u, articleId, "improve");
  }

  @Post("suggest-related")
  @BodylessAction()
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  @ResponseSchema(kbAiBufferedSchema)
  async suggestRelated(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.suggestRelated(u, articleId);
  }

  @Post("suggest-related/stream")
  @BodylessAction()
  @NoTenantTransaction()
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  @ApiOkResponse({ schema: { type: "string" } })
  async suggestRelatedStream(
    @Req() req: Request,
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    return this.streamAction(req, res, u, articleId, "suggest-related");
  }
}
