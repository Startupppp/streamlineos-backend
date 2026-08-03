import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ProjectsReportsService } from "./projects-reports.service";
import { ProjectsAnalyticsService } from "./projects-analytics.service";
import {
  burnupQuerySchema,
  cfdQuerySchema,
  type BurnupQuery,
  type CfdQuery,
} from "./dto/projects.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsReportsController {
  constructor(
    private readonly reports: ProjectsReportsService,
    private readonly analytics: ProjectsAnalyticsService,
  ) {}

  @Get("resource-allocation")
  @RequirePermission("build:view")
  resourceAllocation(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.resourceAllocation(u.orgId);
  }

  @Get(":projectId/analytics")
  @RequirePermission("build:view")
  getAnalytics(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getProjectAnalytics(u.orgId, projectId);
  }

  @Get(":projectId/reports/burnup")
  @RequirePermission("build:view")
  burnup(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(burnupQuerySchema)) query: BurnupQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.burnup(u.orgId, projectId, query);
  }

  @Get(":projectId/reports/cfd")
  @RequirePermission("build:view")
  cfd(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(cfdQuerySchema)) query: CfdQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.cfd(u.orgId, projectId, query);
  }

  @Get(":projectId/reports/critical-path")
  @RequirePermission("build:view")
  criticalPath(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.criticalPath(u.orgId, projectId);
  }

  @Get(":projectId/reports/velocity")
  @RequirePermission("build:view")
  velocity(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.velocity(u.orgId, projectId);
  }

  @Get(":projectId/reports/cycle-time")
  @RequirePermission("build:view")
  getCycleTime(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getCycleTimeReport(u.orgId, projectId);
  }

  @Get(":projectId/reports/lead-time")
  @RequirePermission("build:view")
  getLeadTime(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getLeadTimeReport(u.orgId, projectId);
  }

  @Post(":projectId/reports/snapshot")
  @RequirePermission("build:manage")
  @HttpCode(200)
  snapshot(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.snapshot(u.orgId, projectId);
  }
}
