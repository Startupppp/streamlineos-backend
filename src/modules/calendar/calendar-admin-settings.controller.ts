import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CalendarSourceRegistry } from "./calendar-source.registry";

@Controller("calendar/admin")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CalendarAdminSettingsController {
  constructor(private readonly registry: CalendarSourceRegistry) {}

  @Get("settings")
  @RequirePermission("calendar:admin:manage")
  async getSettings(@CurrentUser() u: CurrentUserContext) {
    const sources = await this.registry.getOrgLevelSources(u.orgId);
    return { sources };
  }
}
