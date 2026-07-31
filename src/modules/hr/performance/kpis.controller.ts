import { Controller, Get, HttpCode, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { KpisService } from "./kpis.service";
import {
  createKpiSchema,
  updateKpiSchema,
  createFrameworkSchema,
  updateFrameworkSchema,
  createCompetencySchema,
  type CreateKpiInput,
  type UpdateKpiInput,
  type CreateFrameworkInput,
  type UpdateFrameworkInput,
  type CreateCompetencyInput,
} from "./dto/kpis.schemas";

@RequireModule("hr")
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
  createKpi(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createKpiSchema)) body: CreateKpiInput,
  ) {
    return this.service.createKpi(u.orgId, body);
  }

  @Patch(":kpiId")
  @RequirePermission("hr:performance:manage")
  updateKpi(
    @CurrentUser() u: CurrentUserContext,
    @Param("kpiId", ParseIntPipe) kpiId: number,
    @Body(new ZodValidationPipe(updateKpiSchema)) body: UpdateKpiInput,
  ) {
    return this.service.updateKpi(u.orgId, kpiId, body);
  }

  @Delete(":kpiId")
  @HttpCode(204)
  @RequirePermission("hr:performance:manage")
  async deleteKpi(@CurrentUser() u: CurrentUserContext, @Param("kpiId", ParseIntPipe) kpiId: number) {
    await this.service.deleteKpi(u.orgId, kpiId);
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
    @Body(new ZodValidationPipe(createFrameworkSchema)) body: CreateFrameworkInput,
  ) {
    return this.service.createFramework(u.orgId, body);
  }

  @Patch("frameworks/:frameworkId")
  @RequirePermission("hr:performance:manage")
  updateFramework(
    @CurrentUser() u: CurrentUserContext,
    @Param("frameworkId", ParseIntPipe) frameworkId: number,
    @Body(new ZodValidationPipe(updateFrameworkSchema)) body: UpdateFrameworkInput,
  ) {
    return this.service.updateFramework(u.orgId, frameworkId, body);
  }

  @Get("frameworks/:frameworkId/competencies")
  @RequirePermission("hr:performance:view")
  listCompetencies(@Param("frameworkId", ParseIntPipe) frameworkId: number, @CurrentUser() u: CurrentUserContext) {
    return this.service.listCompetencies(u.orgId, frameworkId);
  }

  @Post("frameworks/:frameworkId/competencies")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  createCompetency(
    @Param("frameworkId", ParseIntPipe) frameworkId: number,
    @Body(new ZodValidationPipe(createCompetencySchema)) body: CreateCompetencyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createCompetency(u.orgId, frameworkId, body);
  }
}
