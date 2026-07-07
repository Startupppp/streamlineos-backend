import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { logger } from "../../common/logger/logger.service";
import { KbAskService } from "./kb-ask.service";
import { KbChatHistoryService } from "./kb-chat-history.service";
import { askSchema, chatHistoryQuerySchema, type AskInput } from "./dto/kb-ai.schemas";

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
  async askQuestion(
    @Body(new ZodValidationPipe(askSchema)) body: AskInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const result = await this.ask.ask(u, body);
    try {
      await this.history.append(u.orgId, u.userId, "user", body.question);
      await this.history.append(u.orgId, u.userId, "assistant", result.answer, result.citations);
    } catch (error) {
      logger.error("Failed to persist KB chat message", { error });
    }
    return result;
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
}
