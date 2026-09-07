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
import { AiRequestAbortInterceptor, respondWithAiTextStream } from "../../ai/core/streaming";
import { KbPageAiService } from "./kb-page-ai.service";
import { kbAiAskBodySchema, type KbDocAiAction } from "../retrieval/dto/kb-ai.schemas";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();

@Controller("kb/pages/:pageId/ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@UseRateLimit("ai:invoke")
@UseInterceptors(AiRequestAbortInterceptor)
export class KbPageAiController {
  constructor(private readonly svc: KbPageAiService) {}

  /**
   * Every streamed action lands here, so the abort seam, the awaited pipe and
   * the `HttpException` passthrough are configured once for the four of them
   * rather than four times.
   *
   * All four handlers carry `@NoTenantTransaction()` for the same reason: the
   * pipe is awaited, so the request-scoped transaction would stay open and idle
   * for the whole provider stream and pin a pooled connection to it. The service
   * does its tenant-scoped read in its own `runInTenantTransaction` that commits
   * before the provider call, so nothing here reaches the pool without a GUC.
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

  /**
   * The four buffered actions carry `@NoTenantTransaction()` for the SAME reason
   * their streamed siblings do, and it took longer to notice because nothing
   * about the shape looks long-running: `KbPageAiService.run` awaits
   * `gateway.invokeTextWithUsage`, a network round trip to an AI provider, and
   * with the request transaction open that pooled connection is idle in
   * transaction for the whole of it. `withTenant` sets
   * `idle_in_transaction_session_timeout` to 60s, so a slow provider does not
   * just make one request slow — the server kills the transaction while the
   * borrow is still outstanding, which under pool pressure is a tenant-wide
   * failure shape.
   *
   * `check:placement-bypass` was blind to this: it enumerated the DECORATOR, so
   * the four handlers that released the connection were the ones it flagged and
   * the four that held it were invisible. Its `provider-in-transaction` rule now
   * looks for the shape instead.
   *
   * The decorator also removes the tenant context's disconnect signal, which is
   * where `getAmbientAiAbortSignal` was reading cancellation from — hence
   * `@UseInterceptors(AiRequestAbortInterceptor)` on the class, the AI module's
   * own convention for a metered route outside a request transaction.
   */
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
