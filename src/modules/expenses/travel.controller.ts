import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { TravelService } from "./travel.service";

@UseGuards(JwtAuthGuard)
@Controller("hr/travel")
export class TravelController {
  constructor(private readonly service: TravelService) {}

  @Get()
  listMine(@CurrentUser() u: CurrentUserContext) {
    return this.service.listMine(u.orgId, u.userId);
  }

  @Post()
  create(@CurrentUser() u: CurrentUserContext, @Body() body: Record<string, unknown>) {
    return this.service.create(u.orgId, u.userId, body as Parameters<TravelService["create"]>[2]);
  }

  @Get("approvals")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:travel:manage")
  listPending(@CurrentUser() u: CurrentUserContext) {
    return this.service.listPending(u.orgId);
  }

  @Patch(":id/manager-approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:travel:manage")
  managerApprove(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.managerApprove(u.orgId, id, u.userId);
  }

  @Patch(":id/finance-approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:travel:manage")
  financeApprove(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.financeApprove(u.orgId, id, u.userId);
  }

  @Patch(":id/reject")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:travel:manage")
  reject(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number, @Body("reason") reason: string) {
    return this.service.reject(u.orgId, id, reason);
  }
}
