import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { ChatSummarizeService } from "./chat-summarize.service";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const channelIdParams = z.object({ channelId: z.coerce.number().int().positive() }).strict();

@RequireModule("chat")
@Controller("chat/channels/:channelId/summarize")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@RequirePermission("chat:messages:read")
@UseRateLimit("ai:invoke")
export class ChatSummarizeController {
  constructor(private readonly chatSummarizeService: ChatSummarizeService) {}

  @Post()
  @BodylessAction()
  @HttpCode(HttpStatus.OK)
  @Validate({ params: channelIdParams })
  summarize(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.chatSummarizeService.summarize(channelId, {
      orgId: u.orgId,
      userId: u.userId,
    });
  }
}
