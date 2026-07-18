import { Controller, Get, HttpCode, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { KpisService } from "./kpis.service";

@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/kpis")
export class KpisController {
  constructor(private readonly service: KpisService) {}

  @Get()
  @RequirePermission("hr:performance:view")
  listKpis(@CurrentUser() u: CurrentUserContext) {
    return this.service.listKpis(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  createKpi(@CurrentUser() u: CurrentUserContext, @Body() body: Parameters<KpisService["createKpi"]>[1]) {
    return this.service.createKpi(u.orgId, body);
  }

  @Patch(":kpiId")
  @RequirePermission("hr:performance:manage")
  updateKpi(
    @CurrentUser() u: CurrentUserContext,
    @Param("kpiId", ParseIntPipe) kpiId: number,
    @Body() body: Parameters<KpisService["updateKpi"]>[2],
  ) {
    return this.service.updateKpi(u.orgId, kpiId, body);
  }

  @Delete(":kpiId")
  @RequirePermission("hr:performance:manage")
  deleteKpi(@CurrentUser() u: CurrentUserContext, @Param("kpiId", ParseIntPipe) kpiId: number) {
    return this.service.deleteKpi(u.orgId, kpiId);
  }

  @Get("frameworks")
  @RequirePermission("hr:performance:view")
  listFrameworks(@CurrentUser() u: CurrentUserContext) {
    return this.service.listFrameworks(u.orgId);
  }

  @Post("frameworks")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  createFramework(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: Parameters<KpisService["createFramework"]>[1],
  ) {
    return this.service.createFramework(u.orgId, body);
  }

  @Patch("frameworks/:frameworkId")
  @RequirePermission("hr:performance:manage")
  updateFramework(
    @CurrentUser() u: CurrentUserContext,
    @Param("frameworkId", ParseIntPipe) frameworkId: number,
    @Body() body: Parameters<KpisService["updateFramework"]>[2],
  ) {
    return this.service.updateFramework(u.orgId, frameworkId, body);
  }

  @Get("frameworks/:frameworkId/competencies")
  @RequirePermission("hr:performance:view")
  listCompetencies(@Param("frameworkId", ParseIntPipe) frameworkId: number) {
    return this.service.listCompetencies(frameworkId);
  }

  @Post("frameworks/:frameworkId/competencies")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  createCompetency(
    @Param("frameworkId", ParseIntPipe) frameworkId: number,
    @Body() body: Parameters<KpisService["createCompetency"]>[1],
  ) {
    return this.service.createCompetency(frameworkId, body);
  }
}
