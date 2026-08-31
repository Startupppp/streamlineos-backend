import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { actingMembershipId } from "../../common/auth/principal";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { updateChatOrgSettingsSchema, type UpdateChatOrgSettingsInput } from "./dto/chat.schemas";
import { Validate } from "../../common/validation/validate.decorator";

@ApiTags("Chat Org Settings")
@ApiBearerAuth()
@RequireModule("chat")
@Controller("chat/settings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatOrgSettingsController {
  constructor(private readonly settings: ChatOrgSettingsService) {}

  @ApiOperation({ summary: "Get the effective chat settings for the current org" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get()
  @RequirePermission("chat:channels:read")
  get(@CurrentUser() u: CurrentUserContext) {
    return this.settings.getSettings(u.orgId);
  }

  @ApiOperation({ summary: "Update org-level chat settings (chat admins only)" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch()
  @RequirePermission("chat:org-settings:manage")
  @Validate({ body: updateChatOrgSettingsSchema })
  update(
    @Body() body: UpdateChatOrgSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateSettings(u.orgId, actingMembershipId(u.principal), body);
  }
}
