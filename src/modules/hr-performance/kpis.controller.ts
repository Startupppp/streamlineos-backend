import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { KpisService } from "./kpis.service";

@UseGuards(JwtAuthGuard)
@Controller("hr/kpis")
export class KpisController {
  constructor(private readonly service: KpisService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:performance:view")
  listKpis(@CurrentUser() u: CurrentUserContext) {
    return this.service.listKpis(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:performance:manage")
  createKpi(@CurrentUser() u: CurrentUserContext, @Body() body: Parameters<KpisService["createKpi"]>[1]) {
    return this.service.createKpi(u.orgId, body);
  }

  @Patch(":id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:performance:manage")
  updateKpi(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: Parameters<KpisService["updateKpi"]>[2],
  ) {
    return this.service.updateKpi(u.orgId, id, body);
  }

  @Delete(":id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:performance:manage")
  deleteKpi(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.deleteKpi(u.orgId, id);
  }

  @Get("frameworks")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:performance:view")
  listFrameworks(@CurrentUser() u: CurrentUserContext) {
    return this.service.listFrameworks(u.orgId);
  }

  @Post("frameworks")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:performance:manage")
  createFramework(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: Parameters<KpisService["createFramework"]>[1],
  ) {
    return this.service.createFramework(u.orgId, body);
  }

  @Patch("frameworks/:id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:performance:manage")
  updateFramework(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: Parameters<KpisService["updateFramework"]>[2],
  ) {
    return this.service.updateFramework(u.orgId, id, body);
  }

  @Get("frameworks/:id/competencies")
  listCompetencies(@Param("id", ParseIntPipe) frameworkId: number) {
    return this.service.listCompetencies(frameworkId);
  }

  @Post("frameworks/:id/competencies")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:performance:manage")
  createCompetency(
    @Param("id", ParseIntPipe) frameworkId: number,
    @Body() body: Parameters<KpisService["createCompetency"]>[1],
  ) {
    return this.service.createCompetency(frameworkId, body);
  }
}
