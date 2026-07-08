import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { logger } from "../../common/logger/logger.service";
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
  async askQuestion(@Body() body: unknown, @CurrentUser() u: CurrentUserContext): Promise<unknown> {
    const parsed = askSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");

    let conversationId = parsed.data.conversationId;
    if (conversationId === undefined) {
      const conv = await this.history.createConversation(
        u.orgId,
        u.userId,
        parsed.data.question.substring(0, 60).trim(),
      );
      conversationId = conv.id;
    }

    const result = await this.ask.ask(u, parsed.data);
    try {
      await this.history.appendToConversation(u.orgId, u.userId, conversationId, "user", parsed.data.question);
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
  async getHistory(@Query() query: unknown, @CurrentUser() u: CurrentUserContext) {
    const parsed = chatHistoryQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.history.list(u.orgId, u.userId, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
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
  async listConversations(@Query() query: unknown, @CurrentUser() u: CurrentUserContext) {
    const parsed = kbConversationsListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.history.listConversations(u.orgId, u.userId, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
  }

  @Post("ask/conversations")
  @RequirePermission("kb:pages:view")
  async createConversation(@Body() body: unknown, @CurrentUser() u: CurrentUserContext) {
    const parsed = kbConversationCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.history.createConversation(u.orgId, u.userId, parsed.data.title);
  }

  @Patch("ask/conversations/:conversationId")
  @RequirePermission("kb:pages:view")
  async renameConversation(
    @Param("conversationId") conversationIdParam: string,
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const conversationId = parseInt(conversationIdParam, 10);
    if (isNaN(conversationId)) throw new BadRequestException("Invalid conversation ID");
    const parsed = kbConversationRenameSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.history.renameConversation(u.orgId, u.userId, conversationId, parsed.data.title);
  }

  @Delete("ask/conversations/:conversationId")
  @RequirePermission("kb:pages:view")
  async deleteConversation(
    @Param("conversationId") conversationIdParam: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: boolean }> {
    const conversationId = parseInt(conversationIdParam, 10);
    if (isNaN(conversationId)) throw new BadRequestException("Invalid conversation ID");
    await this.history.deleteConversation(u.orgId, u.userId, conversationId);
    return { success: true };
  }

  @Get("ask/conversations/:conversationId/messages")
  @RequirePermission("kb:pages:view")
  async getConversationMessages(
    @Param("conversationId") conversationIdParam: string,
    @Query() query: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const conversationId = parseInt(conversationIdParam, 10);
    if (isNaN(conversationId)) throw new BadRequestException("Invalid conversation ID");
    const parsed = kbConversationMessagesQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.history.listMessages(u.orgId, u.userId, conversationId, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
  }
}
