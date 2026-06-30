import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { OvertimeService } from "./overtime.service";

@RequireModule("hr")
@UseGuards(JwtAuthGuard)
@Controller("hr/overtime")
export class OvertimeController {
  constructor(private readonly service: OvertimeService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.listRequests(u.orgId);
  }

  @Post()
  create(@CurrentUser() u: CurrentUserContext, @Body() body: { date: string; hours: string; reason?: string; convertToCompOff?: boolean }) {
    return this.service.createRequest(u.orgId, u.userId, body);
  }

  @Patch(":id/approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  approve(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.approveRequest(u.orgId, id, u.userId);
  }

  @Patch(":id/reject")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  reject(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.rejectRequest(u.orgId, id, u.userId);
  }

  @Get("comp-off")
  getCompOff(@CurrentUser() u: CurrentUserContext) {
    return this.service.getCompOffBalance(u.orgId, u.userId);
  }
}
