import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { calendarAdminSettingsResponseSchema } from "./dto/admin-settings.schemas";

@Controller("calendar/admin")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CalendarAdminSettingsController {
  constructor(private readonly registry: CalendarSourceRegistry) {}

  @Get("settings")
  @RequirePermission("calendar:admin:manage")
  @ResponseSchema(calendarAdminSettingsResponseSchema)
  async getSettings(@CurrentUser() u: CurrentUserContext) {
    const sources = await this.registry.getOrgLevelSources(u.orgId);
    return { sources };
  }
}
