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
import { kbPageAiBufferedSchema } from "./dto/kb-wiki-response.schemas";
import {
  AiRequestAbortInterceptor,
  createStreamAbortSignal,
  pipeAiUiMessageStream,
  rethrowStreamRouteError,
} from "../../ai/core/streaming";

const KB_PAGE_AI_STREAM_DEADLINE_MS = 60_000;
import { KbPageAiService } from "./kb-page-ai.service";
import { kbAiAskBodySchema, type KbDocAiAction } from "../retrieval/dto/kb-ai.schemas";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();

@Controller("kb/pages/:pageId/ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@UseRateLimit("ai:invoke")
@UseInterceptors(AiRequestAbortInterceptor)
export class KbPageAiController {
  constructor(private readonly svc: KbPageAiService) {}

  private async streamAction(
    req: Request,
    res: Response,
    u: CurrentUserContext,
    pageId: number,
    action: KbDocAiAction,
    question?: string,
  ): Promise<void> {
    const abort = createStreamAbortSignal(req, res, KB_PAGE_AI_STREAM_DEADLINE_MS);
    try {
      const pipe = await this.svc.stream(u, pageId, action, question, abort.signal);
      await pipeAiUiMessageStream(res, pipe, {
        feature: `kb.page-${action}`,
        orgId: u.orgId,
      });
    } catch (error) {
      rethrowStreamRouteError(error, { route: `POST /kb/pages/:pageId/ai/${action}/stream` });
    } finally {
      abort.dispose();
    }
  }

  @Post("summarize")
  @BodylessAction()
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageAiBufferedSchema)
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
  @ApiOkResponse({ schema: { type: "string" } })
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
  @NoTenantTransaction()
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams, body: kbAiAskBodySchema })
  @ResponseSchema(kbPageAiBufferedSchema)
  async ask(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: z.infer<typeof kbAiAskBodySchema>,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.ask(u, pageId, body.question);
  }

  @Post("ask/stream")
  @NoTenantTransaction()
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams, body: kbAiAskBodySchema })
  @ApiOkResponse({ schema: { type: "string" } })
  async askStream(
    @Req() req: Request,
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: z.infer<typeof kbAiAskBodySchema>,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    return this.streamAction(req, res, u, pageId, "ask", body.question);
  }

  @Post("improve")
  @BodylessAction()
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageAiBufferedSchema)
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
  @ApiOkResponse({ schema: { type: "string" } })
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
  @NoTenantTransaction()
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageAiBufferedSchema)
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
  @ApiOkResponse({ schema: { type: "string" } })
  async suggestRelatedStream(
    @Req() req: Request,
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    return this.streamAction(req, res, u, pageId, "suggest-related");
  }
}
