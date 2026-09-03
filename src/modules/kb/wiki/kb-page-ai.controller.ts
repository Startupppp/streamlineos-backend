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
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { respondWithAiTextStream } from "../../ai/core/streaming";
import { KbPageAiService } from "./kb-page-ai.service";
import { kbAiAskBodySchema, type KbDocAiAction } from "../retrieval/dto/kb-ai.schemas";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();

@Controller("kb/pages/:pageId/ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@UseRateLimit("ai:invoke")
export class KbPageAiController {
  constructor(private readonly svc: KbPageAiService) {}

  /**
   * Every streamed action lands here, so the abort seam, the awaited pipe and
   * the `HttpException` passthrough are configured once for the four of them
   * rather than four times.
   */
  private streamAction(
    req: Request,
    res: Response,
    u: CurrentUserContext,
    pageId: number,
    action: KbDocAiAction,
    question?: string,
  ): Promise<void> {
    return respondWithAiTextStream(
      req,
      res,
      {
        feature: `kb.page-${action}`,
        orgId: u.orgId,
        route: `POST /kb/pages/:pageId/ai/${action}/stream`,
      },
      (signal) => this.svc.stream(u, pageId, action, question, signal),
    );
  }

  @Post("summarize")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  async summarize(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.summarize(u, pageId);
  }

  @Post("summarize/stream")
  @BodylessAction()
  @NoTenantTransaction()
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  async summarizeStream(
    @Req() req: Request,
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    return this.streamAction(req, res, u, pageId, "summarize");
  }

  @Post("ask")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams, body: kbAiAskBodySchema })
  async ask(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: { question: string },
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.ask(u, pageId, body.question);
  }

  @Post("ask/stream")
  @NoTenantTransaction()
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams, body: kbAiAskBodySchema })
  async askStream(
    @Req() req: Request,
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: { question: string },
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    return this.streamAction(req, res, u, pageId, "ask", body.question);
  }

  @Post("improve")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  async improve(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.improve(u, pageId);
  }

  @Post("improve/stream")
  @BodylessAction()
  @NoTenantTransaction()
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  async improveStream(
    @Req() req: Request,
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    return this.streamAction(req, res, u, pageId, "improve");
  }

  @Post("suggest-related")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  async suggestRelated(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.suggestRelated(u, pageId);
  }

  @Post("suggest-related/stream")
  @BodylessAction()
  @NoTenantTransaction()
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  async suggestRelatedStream(
    @Req() req: Request,
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    return this.streamAction(req, res, u, pageId, "suggest-related");
  }
}
