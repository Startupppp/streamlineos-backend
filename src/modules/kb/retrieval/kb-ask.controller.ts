import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { NoTenantTransaction } from "../../../common/tenant/no-tenant-transaction.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { logger } from "../../../common/logger/logger.service";
import { KbAskService } from "./kb-ask.service";
import { KbChatHistoryService } from "./kb-chat-history.service";
import {
  askSchema,
  chatHistoryQuerySchema,
  kbConversationCreateSchema,
  kbConversationMessagesQuerySchema,
  kbConversationRenameSchema,
  kbConversationsListQuerySchema,
  type AskInput,
} from "./dto/kb-ai.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  AiRequestAbortInterceptor,
  createStreamAbortSignal,
  encodeStreamSources,
  sourcesTruncatedHeaderName,
  pipeAiTextStream,
  rethrowStreamRouteError,
} from "../../ai/core/streaming";
import { z } from "zod";

const conversationIdParams = z.object({ conversationId: z.coerce.number().int().positive() }).strict();

const KB_ASK_STREAM_DEADLINE_MS = 60_000;
const KB_ASK_CITATIONS_HEADER = "x-kb-citations";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
@UseInterceptors(AiRequestAbortInterceptor)
export class KbAskController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ask: KbAskService,
    private readonly history: KbChatHistoryService,
  ) {}

  /**
   * `@NoTenantTransaction()` because `KbAskService.ask` awaits a provider round
   * trip and the request transaction would otherwise pin a pooled connection
   * idle-in-transaction for the whole of it, against the 60s
   * `idle_in_transaction_session_timeout` `withTenant` sets. The service does
   * its retrieval in a short transaction that commits before the call and its
   * citation re-verification in another afterwards; the three writes this
   * handler owns each get their own, so nothing reaches the pool without a GUC.
   *
   * Creating the conversation is deliberately no longer atomic with the answer.
   * It cannot be — the provider call sits between them — and an empty
   * conversation left behind by a failed answer is a better outcome than a
   * connection held open across the provider.
   */
  @Post("ask")
  @HttpCode(200)
  @Idempotent("kb.ask")
  @NoTenantTransaction()
  @RequirePermission("kb:pages:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("kb:ask")
  @Validate({ body: askSchema })
  async askQuestion(@Body() body: AskInput, @CurrentUser() u: CurrentUserContext): Promise<unknown> {
    const membershipId = actingMembershipId(u.principal) ?? 0;
    /**
     * One `const` settled in a single expression, rather than a reassigned
     * `let` copied into a differently-named alias so the narrowing survives the
     * closure below. A caller-supplied conversation id is a cross-tenant object
     * reference: the only thing that binds it to this caller is
     * KbChatHistoryService.appendToConversation, which resolves the row against
     * kbChatConversations.orgId, and the table's composite tenant foreign key
     * on org_id, conversation_id, which refuses anything else outright.
     * Handing that call an alias hid the binding from every reader that follows
     * the field from the request body to its resolution.
     */
    const conversationId =
      body.conversationId ??
      (
        await runInTenantTransaction(
          this.db,
          () =>
            this.history.createConversation(
              u.orgId,
              u.userId,
              membershipId,
              body.question.substring(0, 60).trim(),
            ),
          { orgId: u.orgId },
        )
      ).id;

    const result = await this.ask.ask(u, body);
    try {
      await runInTenantTransaction(
        this.db,
        async () => {
          await this.history.appendToConversation(u.orgId, u.userId, membershipId, conversationId, "user", body.question);
          await this.history.appendToConversation(
            u.orgId,
            u.userId,
            membershipId,
            conversationId,
            "assistant",
            result.answer,
            result.citations,
          );
        },
        { orgId: u.orgId },
      );
    } catch (error) {
      logger.error("Failed to persist KB chat message", { error });
    }
    return { ...result, conversationId };
  }

  @Post("ask/stream")
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:pages:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("kb:ask")
  @Validate({ body: askSchema })
  async askStream(
    @Req() req: Request,
    @Body() body: AskInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    const abort = createStreamAbortSignal(req, res, KB_ASK_STREAM_DEADLINE_MS);
    try {
      const result = await this.ask.streamAsk(u, body, abort.signal);
      if (!result.hasContext) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("I couldn't find anything about that in the knowledge base. You may want to open a support ticket.");
        return;
      }

      const encoded = encodeStreamSources(result.citations, {
        feature: "kb.ask",
        orgId: u.orgId,
      });
      const truncatedHeader = sourcesTruncatedHeaderName(KB_ASK_CITATIONS_HEADER);
      await pipeAiTextStream(res, result.aiStream.stream, {
        feature: "kb.ask",
        orgId: u.orgId,
        ...(encoded !== null
          ? {
              headers: {
                [KB_ASK_CITATIONS_HEADER]: encoded.encoded,
                ...(encoded.dropped > 0 ? { [truncatedHeader]: String(encoded.dropped) } : {}),
                "access-control-expose-headers":
                  encoded.dropped > 0
                    ? `${KB_ASK_CITATIONS_HEADER}, ${truncatedHeader}`
                    : KB_ASK_CITATIONS_HEADER,
              },
            }
          : {}),
      });
    } catch (error) {
      rethrowStreamRouteError(error, { route: "POST /kb/ask/stream" });
    } finally {
      abort.dispose();
    }
  }

  @Get("ask/history")
  @RequirePermission("kb:pages:view")
  async getHistory(@Query() query: unknown, @CurrentUser() u: CurrentUserContext) {
    const parsed = chatHistoryQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.history.list(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
  }

  @Delete("ask/history")
  @RequirePermission("kb:pages:view")
  async clearHistory(@CurrentUser() u: CurrentUserContext): Promise<{ success: boolean }> {
    await this.history.clear(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0);
    return { success: true };
  }

  @Get("ask/conversations")
  @RequirePermission("kb:pages:view")
  async listConversations(@Query() query: unknown, @CurrentUser() u: CurrentUserContext) {
    const parsed = kbConversationsListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.history.listConversations(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
  }

  @Post("ask/conversations")
  @RequirePermission("kb:pages:view")
  @HttpCode(201)
  @Validate({ body: kbConversationCreateSchema })
  async createConversation(@Body() body: z.infer<typeof kbConversationCreateSchema>, @CurrentUser() u: CurrentUserContext) {
    return this.history.createConversation(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, body.title);
  }

  @Patch("ask/conversations/:conversationId")
  @RequirePermission("kb:pages:view")
  @Validate({ params: conversationIdParams, body: kbConversationRenameSchema })
  async renameConversation(
    @Param("conversationId", ParseIntPipe) conversationId: number,
    @Body() body: z.infer<typeof kbConversationRenameSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.history.renameConversation(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, conversationId, body.title);
  }

  @Delete("ask/conversations/:conversationId")
  @RequirePermission("kb:pages:view")
  @Validate({ params: conversationIdParams })
  async deleteConversation(
    @Param("conversationId", ParseIntPipe) conversationId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: boolean }> {
    await this.history.deleteConversation(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, conversationId);
    return { success: true };
  }

  @Get("ask/conversations/:conversationId/messages")
  @RequirePermission("kb:pages:view")
  @Validate({ params: conversationIdParams })
  async getConversationMessages(
    @Param("conversationId", ParseIntPipe) conversationId: number,
    @Query() query: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const parsed = kbConversationMessagesQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.history.listMessages(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, conversationId, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
  }
}
