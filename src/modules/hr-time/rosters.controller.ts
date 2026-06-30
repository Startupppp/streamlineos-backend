import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards, Query } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RostersService } from "./rosters.service";

@RequireModule("hr")
@UseGuards(JwtAuthGuard)
@Controller("hr/rosters")
export class RostersController {
  constructor(private readonly service: RostersService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  list(@CurrentUser() u: CurrentUserContext, @Query("weekStart") _weekStart?: string) {
    return this.service.listRosters(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  create(@CurrentUser() u: CurrentUserContext, @Body() body: { name: string; weekStart: string; weekEnd: string }) {
    return this.service.createRoster(u.orgId, u.userId, body);
  }

  @Get(":id/entries")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  getEntries(@Param("id", ParseIntPipe) id: number) {
    return this.service.getRosterEntries(id);
  }

  @Post(":id/entries")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  upsertEntry(@Param("id", ParseIntPipe) id: number, @Body() body: { userId: string; shiftId?: number; date: string; isDayOff?: boolean; notes?: string }) {
    return this.service.upsertRosterEntry({ rosterId: id, ...body });
  }

  @Patch(":id/publish")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  publish(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.publishRoster(u.orgId, id);
  }
}
