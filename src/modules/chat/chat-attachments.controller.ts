import { Controller, Get, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { chatAttachmentParamsSchema } from "./dto/chat-attachment.schemas";
import { ChatAttachmentsService } from "./chat-attachments.service";

@ApiTags("Chat Attachments")
@ApiBearerAuth()
@Controller("chat/channels")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatAttachmentsController {
  constructor(private readonly attachments: ChatAttachmentsService) {}

  @ApiOperation({ summary: "Get a short-lived signed URL for a channel attachment" })
  @ApiResponse({ status: 200, description: "OK" })
  @ApiResponse({ status: 403, description: "Not a member of a public channel" })
  @ApiResponse({ status: 404, description: "Attachment not found or channel is private and caller is not a member" })
  @Get(":channelId/attachments/:attachmentId")
  @RequirePermission("chat:messages:read")
  @Validate({ params: chatAttachmentParamsSchema })
  getSignedUrl(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("attachmentId", ParseIntPipe) attachmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.attachments.getSignedUrl(channelId, attachmentId, u.userId, u.orgId);
  }
}
