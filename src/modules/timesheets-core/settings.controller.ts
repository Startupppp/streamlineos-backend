import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SettingsService } from "./settings.service";
import { updateCoreSettingsSchema, type UpdateCoreSettingsInput } from "./dto/settings.schemas";

@RequireModule("projects")
@Controller("timesheets/settings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermission("timesheets:settings:view")
  get(@CurrentUser() u: CurrentUserContext) {
    return this.settings.getSettings(u.orgId);
  }

  @Patch()
  @RequirePermission("timesheets:settings:manage")
  update(
    @Body(new ZodValidationPipe(updateCoreSettingsSchema)) body: UpdateCoreSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateSettings(u, body);
  }
}
