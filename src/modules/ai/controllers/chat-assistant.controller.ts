import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  InternalServerErrorException,
  Post,
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
import { OrgFeaturesService } from "../services/org-features.service";
import { AiUsageService } from "../services/ai-usage.service";
import { chatRequestSchema } from "../dto/request.schemas";

@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatAssistantController {
  constructor(
    private readonly chat: ChatAssistantService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly usage: AiUsageService,
  ) {}

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

      void result.usage
        .then((usage) => {
          if (!usage) return;
          void this.usage.track({
            orgId: u.orgId,
            userId: u.userId,
            feature: "ai_chat",
            model: "gemini-1.5-pro-latest",
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
