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
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbChatHistoryService } from "./kb-chat-history.service";
import {
  kbConversationCreateSchema,
  kbConversationMessagesQuerySchema,
  kbConversationRenameSchema,
  kbConversationsListQuerySchema,
} from "./dto/kb-ai.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  kbChatHistoryPageSchema,
  kbChatSuccessSchema,
  kbConversationListPageSchema,
  kbConversationResponseSchema,
} from "./dto/kb-retrieval-response.schemas";
import { z } from "zod";

const conversationIdParams = z.object({ conversationId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbConversationsController {
  constructor(private readonly history: KbChatHistoryService) {}

  @Get("ask/conversations")
  @RequirePermission("kb:pages:view")
  @ResponseSchema(kbConversationListPageSchema)
  async listConversations(@Query() query: unknown, @CurrentUser() u: CurrentUserContext) {
    const parsed = kbConversationsListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.history.listConversations(u, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
      q: parsed.data.q,
    });
  }

  @Post("ask/conversations")
  @RequirePermission("kb:pages:view")
  @HttpCode(201)
  @Validate({ body: kbConversationCreateSchema })
  @ResponseSchema(kbConversationResponseSchema)
  async createConversation(@Body() body: z.infer<typeof kbConversationCreateSchema>, @CurrentUser() u: CurrentUserContext) {
    return this.history.createConversation(u, body.title);
  }

  @Patch("ask/conversations/:conversationId")
  @RequirePermission("kb:pages:view")
  @Validate({ params: conversationIdParams, body: kbConversationRenameSchema })
  @ResponseSchema(kbConversationResponseSchema)
  async renameConversation(
    @Param("conversationId", ParseIntPipe) conversationId: number,
    @Body() body: z.infer<typeof kbConversationRenameSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.history.renameConversation(u, conversationId, body.title);
  }

  @Delete("ask/conversations/:conversationId")
  @RequirePermission("kb:pages:view")
  @Validate({ params: conversationIdParams })
  @ResponseSchema(kbChatSuccessSchema)
  async deleteConversation(
    @Param("conversationId", ParseIntPipe) conversationId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: boolean }> {
    await this.history.deleteConversation(u, conversationId);
    return { success: true };
  }

  @Get("ask/conversations/:conversationId/messages")
  @RequirePermission("kb:pages:view")
  @Validate({ params: conversationIdParams })
  @ResponseSchema(kbChatHistoryPageSchema)
  async getConversationMessages(
    @Param("conversationId", ParseIntPipe) conversationId: number,
    @Query() query: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const parsed = kbConversationMessagesQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.history.listMessages(u, conversationId, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
  }
}
