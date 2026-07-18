import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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
  @RequirePermission("hr:performance:manage")
  createKpi(@CurrentUser() u: CurrentUserContext, @Body(new ZodValidationPipe(createKpiSchema)) body: CreateKpiInput) {
    return this.service.createKpi(u.orgId, body);
  }

  @Patch(":id")
  @RequirePermission("hr:performance:manage")
  updateKpi(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateKpiSchema)) body: UpdateKpiInput,
  ) {
    return this.service.updateKpi(u.orgId, id, body);
  }

  @Delete(":id")
  @RequirePermission("hr:performance:manage")
  deleteKpi(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.deleteKpi(u.orgId, id);
  }

  @Get("frameworks")
  @RequirePermission("hr:performance:view")
  listFrameworks(@CurrentUser() u: CurrentUserContext) {
    return this.service.listFrameworks(u.orgId);
  }

  @Post("frameworks")
  @RequirePermission("hr:performance:manage")
  createFramework(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createFrameworkSchema)) body: CreateFrameworkInput,
  ) {
    return this.service.createFramework(u.orgId, body);
  }

  @Patch("frameworks/:id")
  @RequirePermission("hr:performance:manage")
  updateFramework(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateFrameworkSchema)) body: UpdateFrameworkInput,
  ) {
    return this.service.updateFramework(u.orgId, id, body);
  }

  @Get("frameworks/:id/competencies")
  @RequirePermission("hr:performance:view")
  listCompetencies(@Param("id", ParseIntPipe) frameworkId: number) {
    return this.service.listCompetencies(frameworkId);
  }

  @Post("frameworks/:id/competencies")
  @RequirePermission("hr:performance:manage")
  createCompetency(
    @Param("id", ParseIntPipe) frameworkId: number,
    @Body(new ZodValidationPipe(createCompetencySchema)) body: CreateCompetencyInput,
  ) {
    return this.service.createCompetency(frameworkId, body);
  }
}
