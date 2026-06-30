import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { BiometricService } from "./biometric.service";

@RequireModule("hr")
@UseGuards(JwtAuthGuard)
@Controller("hr/biometric")
export class BiometricController {
  constructor(private readonly service: BiometricService) {}

  @Get("devices")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  listDevices(@CurrentUser() u: CurrentUserContext) {
    return this.service.listDevices(u.orgId);
  }

  @Post("devices")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  createDevice(@CurrentUser() u: CurrentUserContext, @Body() body: { name: string; ipAddress: string; port?: number; vendor?: string; location?: string }) {
    return this.service.createDevice(u.orgId, body);
  }

  @Patch("devices/:id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  updateDevice(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number, @Body() body: Partial<Parameters<BiometricService["updateDevice"]>[2]>) {
    return this.service.updateDevice(u.orgId, id, body);
  }

  @Get("logs")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  getLogs(@CurrentUser() u: CurrentUserContext) {
    return this.service.getLogs(u.orgId);
  }
}
