import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { GeofencingService } from "./geofencing.service";

@RequireModule("hr")
@UseGuards(JwtAuthGuard)
@Controller("hr/geofencing")
export class GeofencingController {
  constructor(private readonly service: GeofencingService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  create(@CurrentUser() u: CurrentUserContext, @Body() body: { name: string; lat: string; lng: string; radiusMeters?: number }) {
    return this.service.create(u.orgId, body);
  }

  @Patch(":id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  update(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number, @Body() body: Partial<Parameters<GeofencingService["update"]>[2]>) {
    return this.service.update(u.orgId, id, body);
  }

  @Delete(":id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  remove(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.remove(u.orgId, id);
  }
}
