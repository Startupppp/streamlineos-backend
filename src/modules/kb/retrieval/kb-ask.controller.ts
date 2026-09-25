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
import { ApiHeader } from "@nestjs/swagger";
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
  kbCreateKnowledgeGapSchema,
  type AskInput,
  type KbCreateKnowledgeGapInput,
} from "./dto/kb-ai.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  AiRequestAbortInterceptor,
  respondWithAiTextStream,
} from "../../ai/core/streaming";
import { createAiResultStream, AI_RESULT_STREAM_CONTENT_TYPE } from "../../ai/core/streaming/ai-result-stream";
import { createPipeableAiTextStream } from "../../ai/core/streaming/raw-ai-text-stream";
import type { AskCitation } from "./kb-ask.service";
import type { AiUsageMeta } from "../../ai/core/gateway/ai-gateway.types";
import { ApiAiResultStream } from "../../ai/core/streaming/ai-result-stream-contract";
import { COMMAND_FENCE_STORE, type CommandFenceStore } from "../../../common/idempotency/command-fence-store";
import { claimAiStreamCommand, completeAiStreamCommand } from "../../ai/core/streaming/ai-stream-command";
import { kbAskResultSchema } from "./dto/kb-ask-result.schema";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  kbAskAnswerSchema,
  kbChatHistoryPageSchema,
  kbChatSuccessSchema,
} from "./dto/kb-retrieval-response.schemas";
import { z } from "zod";

const KB_ASK_STREAM_DEADLINE_MS = 55_000;

function completedKbStream(data: { answer: string }) {
  return { stream: createPipeableAiTextStream(new ReadableStream<string>({ start(controller) {
    controller.enqueue(`${JSON.stringify({ type: "text", text: data.answer })}\n`);
    controller.enqueue(`${JSON.stringify({ type: "result", data })}\n`);
    controller.close();
  } })) };
}

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
@UseInterceptors(AiRequestAbortInterceptor)
export class KbAskController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ask: KbAskService,
    private readonly history: KbChatHistoryService,
    @Inject(COMMAND_FENCE_STORE) private readonly fences: CommandFenceStore,
  ) {}

  @Post("ask")
  @HttpCode(200)
  @Idempotent("kb.ask")
  @NoTenantTransaction()
  @RequirePermission("kb:ai:generate")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("kb:ask")
  @Validate({ body: askSchema })
  @ResponseSchema(kbAskAnswerSchema)
  async askQuestion(@Body() body: AskInput, @CurrentUser() u: CurrentUserContext): Promise<unknown> {
    const membershipId = actingMembershipId(u.principal) ?? 0;
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

    const result = await this.ask.ask(u, body, { companyDocuments: true });
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
  @ApiHeader({ name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 1, maxLength: 200 }, description: "Stable key for one generation attempt. Completed attempts replay after current access checks; an already-started attempt returns 409, and a different request or caller using the key returns 422. Use a new key only for an intentional regeneration." })
  @ApiAiResultStream()
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:ai:generate")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("kb:ask")
  @Validate({ body: askSchema })
  async askStream(
    @Req() req: Request,
    @Body() body: AskInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    await respondWithAiTextStream(req, res, {
      feature: "kb.ask", orgId: u.orgId, route: "POST /kb/ask/stream",
      deadlineMs: KB_ASK_STREAM_DEADLINE_MS, contentType: AI_RESULT_STREAM_CONTENT_TYPE,
    }, async (signal) => {
      const membershipId = actingMembershipId(u.principal) ?? 0;
      if (body.conversationId !== undefined)
        await runInTenantTransaction(this.db, () => this.history.listMessages(
          u.orgId, u.userId, membershipId, body.conversationId ?? 0, { limit: 1 },
        ), { orgId: u.orgId });
      const claim = await runInTenantTransaction(this.db, () => claimAiStreamCommand(this.fences, {
        key: req.headers["idempotency-key"], command: "kb.ask.stream",
        orgId: u.orgId, userId: u.userId, membershipId,
        audience: u.sessionId.startsWith("pat:") ? "pat" : "internal", body,
      }), { orgId: u.orgId });
      if (claim.kind === "replay") {
        const data = kbAskResultSchema.parse(claim.data);
        await runInTenantTransaction(this.db, async () => {
          await this.history.listMessages(u.orgId, u.userId, membershipId, data.conversationId, { limit: 1 });
          await this.ask.assertReplayCitations(u, data.citations);
        }, { orgId: u.orgId });
        return completedKbStream(data);
      }
      const result = await this.ask.streamAsk(u, body, signal, { companyDocuments: true });
      const complete = async (answer: string, citations: AskCitation[], aiUsage?: AiUsageMeta) =>
        runInTenantTransaction(this.db, async () => {
          signal.throwIfAborted();
          const conversationId = body.conversationId ?? (await this.history.createConversation(
            u.orgId, u.userId, membershipId, body.question.substring(0, 60).trim(),
          )).id;
          await this.history.appendToConversation(u.orgId, u.userId, membershipId, conversationId, "user", body.question);
          await this.history.appendToConversation(u.orgId, u.userId, membershipId, conversationId, "assistant", answer, citations);
          signal.throwIfAborted();
          const data = { answer, citations, hasContext: result.hasContext, aiUsage, conversationId };
          await completeAiStreamCommand(this.fences, claim.fenceId, u.orgId, data);
          return data;
        }, { orgId: u.orgId });
      if (!result.hasContext) {
        const answer = "I couldn't find anything about that in the knowledge base. You may want to open a support ticket.";
        const data = await complete(answer, []);
        return completedKbStream(data);
      }
      return createAiResultStream({
        generation: result.aiStream, signal,
        complete: async (answer, aiUsage) => complete(answer, await result.verifyCitations(), aiUsage),
      });
    });
  }

  @Get("ask/history")
  @RequirePermission("kb:pages:view")
  @ResponseSchema(kbChatHistoryPageSchema)
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
  @ResponseSchema(kbChatSuccessSchema)
  async clearHistory(@CurrentUser() u: CurrentUserContext): Promise<{ success: boolean }> {
    await this.history.clear(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0);
    return { success: true };
  }

  @Post("ask/knowledge-gap")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("kb:ask")
  @Validate({ body: kbCreateKnowledgeGapSchema })
  @ResponseSchema(kbChatSuccessSchema)
  async createKnowledgeGap(
    @Body() body: KbCreateKnowledgeGapInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: boolean }> {
    await this.ask.reportKnowledgeGap(u, body.question);
    return { success: true };
  }

}
