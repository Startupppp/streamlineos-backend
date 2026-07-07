import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  InternalServerErrorException,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { logger } from "../../../common/logger/logger.service";
import { ChatAssistantService } from "../services/chat-assistant.service";
import { ChatHistoryService } from "../services/chat-history.service";
import { OrgFeaturesService } from "../services/org-features.service";
import { AiUsageService } from "../services/ai-usage.service";
import { chatHistoryQuerySchema, chatRequestSchema } from "../dto/request.schemas";

@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatAssistantController {
  constructor(
    private readonly chat: ChatAssistantService,
    private readonly history: ChatHistoryService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly usage: AiUsageService,
  ) {}

  @Get("history")
  @RequirePermission("ai:chat:use")
  async getHistory(@Query() query: unknown, @CurrentUser() u: CurrentUserContext) {
    const parsed = chatHistoryQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.history.list(u.orgId, u.userId, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
  }

  @Delete("history")
  @RequirePermission("ai:chat:use")
  async clearHistory(@CurrentUser() u: CurrentUserContext): Promise<{ success: boolean }> {
    await this.history.clear(u.orgId, u.userId);
    return { success: true };
  }

  @Post()
  @RequirePermission("ai:chat:use")
  async chatAssistant(
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");

    const flags = await this.orgFeatures.getFlags(u.orgId);
    if (!flags.aiChat) {
      throw new ForbiddenException("AI chat is disabled for this organization.");
    }

    try {
      const result = await this.chat.processChat(parsed.data.messages, u.userId, u.orgId);
      const model = this.chat.getChatModelId();

      void result.usage
        .then((usage) => {
          if (!usage) return;
          void this.usage.track({
            orgId: u.orgId,
            userId: u.userId,
            feature: "ai_chat",
            model,
            promptTokens: usage.inputTokens ?? 0,
            completionTokens: usage.outputTokens ?? 0,
          });
        })
        .catch(() => undefined);

      result.pipeTextStreamToResponse(res);
    } catch (error) {
      logger.error("Chat route error", { error });
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
