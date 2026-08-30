import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
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
import { logger } from "../../../common/logger/logger.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { KbAskService } from "./kb-ask.service";
import { KbChatHistoryService } from "./kb-chat-history.service";
import {
  askSchema,
  chatHistoryQuerySchema,
  kbConversationCreateSchema,
  kbConversationMessagesQuerySchema,
  kbConversationRenameSchema,
  kbConversationsListQuerySchema,
} from "./dto/kb-ai.schemas";

const conversationIdParams = z.object({ conversationId: z.coerce.number().int().positive() }).strict();

type AskInput = z.infer<typeof askSchema>;
type ChatHistoryQuery = z.infer<typeof chatHistoryQuerySchema>;
type KbConversationsListQuery = z.infer<typeof kbConversationsListQuerySchema>;
type KbConversationCreateInput = z.infer<typeof kbConversationCreateSchema>;
type KbConversationRenameInput = z.infer<typeof kbConversationRenameSchema>;
type KbConversationMessagesQuery = z.infer<typeof kbConversationMessagesQuerySchema>;

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbAskController {
  constructor(
    private readonly ask: KbAskService,
    private readonly history: KbChatHistoryService,
  ) {}

  @Post("ask")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("kb:ask")
  @Validate({ body: askSchema })
  async askQuestion(@Body() body: AskInput, @CurrentUser() u: CurrentUserContext): Promise<unknown> {
    let conversationId = body.conversationId;
    if (conversationId === undefined) {
      const conv = await this.history.createConversation(
        u.orgId,
        u.userId,
        body.question.substring(0, 60).trim(),
      );
      conversationId = conv.id;
    }

    const result = await this.ask.ask(u, body);
    try {
      await this.history.appendToConversation(u.orgId, u.userId, conversationId, "user", body.question);
      await this.history.appendToConversation(
        u.orgId,
        u.userId,
        conversationId,
        "assistant",
        result.answer,
        result.citations,
      );
    } catch (error) {
      logger.error("Failed to persist KB chat message", { error });
    }
    return { ...result, conversationId };
  }

  @Get("ask/history")
  @RequirePermission("kb:pages:view")
  @Validate({ query: chatHistoryQuerySchema })
  async getHistory(@Query() query: ChatHistoryQuery, @CurrentUser() u: CurrentUserContext) {
    return this.history.list(u.orgId, u.userId, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Delete("ask/history")
  @RequirePermission("kb:pages:view")
  async clearHistory(@CurrentUser() u: CurrentUserContext): Promise<{ success: boolean }> {
    await this.history.clear(u.orgId, u.userId);
    return { success: true };
  }

  @Get("ask/conversations")
  @RequirePermission("kb:pages:view")
  @Validate({ query: kbConversationsListQuerySchema })
  async listConversations(@Query() query: KbConversationsListQuery, @CurrentUser() u: CurrentUserContext) {
    return this.history.listConversations(u.orgId, u.userId, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post("ask/conversations")
  @RequirePermission("kb:pages:view")
  @HttpCode(201)
  @Validate({ body: kbConversationCreateSchema })
  async createConversation(@Body() body: KbConversationCreateInput, @CurrentUser() u: CurrentUserContext) {
    return this.history.createConversation(u.orgId, u.userId, body.title);
  }

  @Patch("ask/conversations/:conversationId")
  @RequirePermission("kb:pages:view")
  @Validate({ params: conversationIdParams, body: kbConversationRenameSchema })
  async renameConversation(
    @Param("conversationId", ParseIntPipe) conversationId: number,
    @Body() body: KbConversationRenameInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.history.renameConversation(u.orgId, u.userId, conversationId, body.title);
  }

  @Delete("ask/conversations/:conversationId")
  @RequirePermission("kb:pages:view")
  @Validate({ params: conversationIdParams })
  async deleteConversation(
    @Param("conversationId", ParseIntPipe) conversationId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: boolean }> {
    await this.history.deleteConversation(u.orgId, u.userId, conversationId);
    return { success: true };
  }

  @Get("ask/conversations/:conversationId/messages")
  @RequirePermission("kb:pages:view")
  @Validate({ params: conversationIdParams, query: kbConversationMessagesQuerySchema })
  async getConversationMessages(
    @Param("conversationId", ParseIntPipe) conversationId: number,
    @Query() query: KbConversationMessagesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.history.listMessages(u.orgId, u.userId, conversationId, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}
