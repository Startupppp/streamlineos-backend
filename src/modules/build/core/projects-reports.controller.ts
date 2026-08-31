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
import { ProjectsReportsService } from "./projects-reports.service";
import { ProjectsAnalyticsService } from "./projects-analytics.service";
import {
  burnupQuerySchema,
  cfdQuerySchema,
  type BurnupQuery,
  type CfdQuery,
} from "./dto/projects.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ params: projectIdParams })
  getAnalytics(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getProjectAnalytics(u.orgId, projectId);
  }

  @Get(":projectId/reports/burnup")
  @RequirePermission("build:view")
  @Validate({ params: projectIdParams, query: burnupQuerySchema })
  burnup(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: BurnupQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.burnup(u.orgId, projectId, query);
  }

  @Get(":projectId/reports/cfd")
  @RequirePermission("build:view")
  @Validate({ params: projectIdParams, query: cfdQuerySchema })
  cfd(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: CfdQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.cfd(u.orgId, projectId, query);
  }

  @Get(":projectId/reports/critical-path")
  @RequirePermission("build:view")
  @Validate({ params: projectIdParams })
  criticalPath(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.criticalPath(u.orgId, projectId);
  }

  @Get(":projectId/reports/velocity")
  @RequirePermission("build:view")
  @Validate({ params: projectIdParams })
  velocity(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.velocity(u.orgId, projectId);
  }

  @Get(":projectId/reports/cycle-time")
  @RequirePermission("build:view")
  @Validate({ params: projectIdParams })
  getCycleTime(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getCycleTimeReport(u.orgId, projectId);
  }

  @Get(":projectId/reports/lead-time")
  @RequirePermission("build:view")
  @Validate({ params: projectIdParams })
  getLeadTime(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getLeadTimeReport(u.orgId, projectId);
  }

  @Post(":projectId/reports/snapshot")
  @RequirePermission("build:manage")
  @HttpCode(200)
  @Validate({ params: projectIdParams })
  snapshot(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.snapshot(u.orgId, projectId);
  }
}
