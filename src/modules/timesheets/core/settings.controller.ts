import { Body, Controller, Get, Patch, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { SettingsService } from "./settings.service";
import {
  settingsHistoryQuerySchema,
  updateCoreSettingsSchema,
  type SettingsHistoryQuery,
  type UpdateCoreSettingsInput,
} from "./dto/settings.schemas";

@RequireModule("build")
@Controller("timesheets/settings")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermission("timesheets:settings:view")
  get(@CurrentUser() u: CurrentUserContext) {
    return this.settings.getSettings(u.orgId);
  }

  @Get("history")
  @RequirePermission("timesheets:settings:view")
  history(
    @Query(new ZodValidationPipe(settingsHistoryQuerySchema)) query: SettingsHistoryQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.getSettingsHistory(u.orgId, query.limit);
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
