import {
  BadRequestException,
  Body,
  Inject,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { NoTenantTransaction } from "../../../../common/tenant";
import { z } from "zod";
import { ChatAssistantService } from "../services/chat-assistant.service";
import { ChatHistoryService } from "../services/chat-history.service";
import { OrgFeaturesService } from "../services/org-features.service";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import {
  chatHistoryQuerySchema,
  chatRequestSchema,
  confirmActionBodySchema,
  conversationCreateSchema,
  conversationMessagesQuerySchema,
  conversationRenameSchema,
  conversationsListQuerySchema,
} from "../dto/request.schemas";
import { ToolAccessService } from "../tool-access.service";
import { findConfirmableAction } from "../confirm-actions";
import { actingMembershipId } from "../../../../common/auth/principal";
import { Validate } from "../../../../common/validation/validate.decorator";
import {
  createStreamAbortSignal,
  pipeAiUiMessageStream,
  rethrowStreamRouteError,
} from "../streaming";
import { AiRequestAbortInterceptor } from "../streaming";
import { ApiOkResponse } from "@nestjs/swagger";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import {
  chatHistoryResponseSchema,
  chatClearHistoryResponseSchema,
  listConversationsResponseSchema,
  aiConversationSchema,
  deleteConversationResponseSchema,
  confirmActionResponseSchema,
} from "../dto/ai-response.schemas";

export const CHAT_STREAM_DEADLINE_MS = 120_000;

const conversationIdParams = z.object({ conversationId: z.coerce.number().int().positive() }).strict();

@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
@UseInterceptors(AiRequestAbortInterceptor)
export class ChatAssistantController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly chat: ChatAssistantService,
    private readonly history: ChatHistoryService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly confirmation: AiConfirmationService,
    private readonly toolAccess: ToolAccessService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Get("history")
  @RequirePermission("ai:chat:use")
  @ResponseSchema(chatHistoryResponseSchema)
  @Validate({ query: chatHistoryQuerySchema })
  async getHistory(@Query() query: z.infer<typeof chatHistoryQuerySchema>, @CurrentUser() u: CurrentUserContext) {
    return this.history.list(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Delete("history")
  @RequirePermission("ai:chat:use")
  @ResponseSchema(chatClearHistoryResponseSchema)
  async clearHistory(@CurrentUser() u: CurrentUserContext): Promise<{ success: boolean }> {
    await this.history.clear(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0);
    return { success: true };
  }

  @Get("conversations")
  @RequirePermission("ai:chat:use")
  @ResponseSchema(listConversationsResponseSchema)
  @Validate({ query: conversationsListQuerySchema })
  async listConversations(@Query() query: z.infer<typeof conversationsListQuerySchema>, @CurrentUser() u: CurrentUserContext) {
    return this.history.listConversations(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post("conversations")
  @HttpCode(201)
  @RequirePermission("ai:chat:use")
  @ResponseSchema(aiConversationSchema)
  @Validate({ body: conversationCreateSchema })
  async createConversation(@Body() body: z.infer<typeof conversationCreateSchema>, @CurrentUser() u: CurrentUserContext) {
    return this.history.createConversation(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, body.title);
  }

  @Patch("conversations/:conversationId")
  @RequirePermission("ai:chat:use")
  @ResponseSchema(aiConversationSchema)
  @Validate({ params: conversationIdParams, body: conversationRenameSchema })
  async renameConversation(
    @Param("conversationId") conversationIdParam: string,
    @Body() body: z.infer<typeof conversationRenameSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.history.renameConversation(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, Number(conversationIdParam), body.title);
  }

  @Delete("conversations/:conversationId")
  @RequirePermission("ai:chat:use")
  @ResponseSchema(deleteConversationResponseSchema)
  @Validate({ params: conversationIdParams })
  async deleteConversation(
    @Param("conversationId") conversationIdParam: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: boolean }> {
    await this.history.deleteConversation(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, Number(conversationIdParam));
    return { success: true };
  }

  @Get("conversations/:conversationId/messages")
  @RequirePermission("ai:chat:use")
  @ResponseSchema(chatHistoryResponseSchema)
  @Validate({ params: conversationIdParams, query: conversationMessagesQuerySchema })
  async getConversationMessages(
    @Param("conversationId") conversationIdParam: string,
    @Query() query: z.infer<typeof conversationMessagesQuerySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.history.listMessages(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, Number(conversationIdParam), {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post()
  @RequirePermission("ai:chat:use")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:chat")
  @NoTenantTransaction()
  @ApiOkResponse({ description: "AI UI message stream", content: { "text/event-stream": { schema: { type: "string" } } } })
  @Validate({ body: chatRequestSchema })
  async chatAssistant(
    @Req() req: Request,
    @Body() body: z.infer<typeof chatRequestSchema>,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    const flags = await this.orgFeatures.getFlags(u.orgId);
    if (!flags.aiChat) {
      throw new ForbiddenException("AI chat is disabled for this organization.");
    }

    const abort = createStreamAbortSignal(req, res, CHAT_STREAM_DEADLINE_MS);

    try {
      const result = await this.chat.processChat(
        body.messages,
        u,
        body.conversationId,
        body.persona,
        abort.signal,
      );
      await pipeAiUiMessageStream(res, result, { feature: "ai.chat", orgId: u.orgId });
    } catch (error) {
      rethrowStreamRouteError(error, { route: "POST /chat" });
    } finally {
      abort.dispose();
    }
  }

  @Post("confirm")
  @RequirePermission("ai:chat:use")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:chat")
  @NoTenantTransaction()
  @ResponseSchema(confirmActionResponseSchema)
  @Validate({ body: confirmActionBodySchema })
  async confirmAction(@Body() body: z.infer<typeof confirmActionBodySchema>, @CurrentUser() u: CurrentUserContext) {
    const flags = await this.orgFeatures.getFlags(u.orgId);
    if (!flags.aiChat) {
      throw new ForbiddenException("AI chat is disabled for this organization.");
    }

    const confirmed = await this.confirmation.confirm({
      token: body.token,
      actor: { orgId: u.orgId, userId: u.userId },
    });
    const { proposalId, action, payload } = confirmed;

    const definition = findConfirmableAction(action);
    if (!definition) throw new BadRequestException(`Unknown action type: ${action}`);

    const denyReason = await this.toolAccess.denyReason(u, definition.permission);
    if (denyReason) throw new ForbiddenException(denyReason);

    const input = definition.payload.safeParse(payload);
    if (!input.success)
      throw new BadRequestException(`Invalid payload for action ${action}`);

    const { result, summary } = await definition.execute(input.data, {
      actor: u,
      db: this.db,
      moduleRef: this.moduleRef,
      proposalId,
    });

    await this.confirmation.markExecuted(proposalId, result, u.orgId);
    return { ok: true, result, summary };
  }
}
