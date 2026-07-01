import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RecruitmentRequisitionsService } from "./recruitment-requisitions.service";

@UseGuards(JwtAuthGuard)
@Controller("hr/recruitment/requisitions")
export class RecruitmentRequisitionsController {
  constructor(private readonly service: RecruitmentRequisitionsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:requisitions:view")
  list(@CurrentUser() u: CurrentUserContext, @Query("status") status?: string) {
    return this.service.list(u.orgId, status);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:requisitions:view")
  create(@CurrentUser() u: CurrentUserContext, @Body() body: Record<string, unknown>) {
    return this.service.create(u.orgId, u.userId, body as Parameters<RecruitmentRequisitionsService["create"]>[2]);
  }

  @Patch(":id/submit")
  submit(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.submit(u.orgId, id);
  }

  @Patch(":id/approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:requisitions:manage")
  approve(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.approve(u.orgId, id, u.userId);
  }

  @Patch(":id/reject")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:requisitions:manage")
  reject(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number, @Body("reason") reason: string) {
    return this.service.reject(u.orgId, id, u.userId, reason);
  }

  @Patch(":id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:requisitions:view")
  update(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number, @Body() body: Record<string, unknown>) {
    return this.service.update(u.orgId, id, body as Parameters<RecruitmentRequisitionsService["update"]>[2]);
  }
}
