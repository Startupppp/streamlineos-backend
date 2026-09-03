import {
  BadRequestException,
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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { actingMembershipId } from "../../../common/auth/principal";
import { z } from "zod";

const conversationIdParams = z.object({ conversationId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequireModule("kb")
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
    const membershipId = actingMembershipId(u.principal) ?? 0;
    let conversationId = body.conversationId;
    if (conversationId === undefined) {
      const conv = await this.history.createConversation(
        u.orgId,
        u.userId,
        membershipId,
        body.question.substring(0, 60).trim(),
      );
      conversationId = conv.id;
    }

    const result = await this.ask.ask(u, body);
    try {
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
