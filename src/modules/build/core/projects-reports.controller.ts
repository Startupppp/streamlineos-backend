import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import type { Response } from "express";
import {
  projectAnalyticsQuerySchema,
  resourceAllocationQuerySchema,
  velocityQuerySchema,
  type ProjectAnalyticsQuery,
  type ResourceAllocationQuery,
  type VelocityQuery,
} from "./dto/analytics.schemas";
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
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  analyticsSchema,
  burnupDataSchema,
  cfdDataSchema,
  criticalPathSchema,
  cycleTimeSchema,
  leadTimeSchema,
  resourceAllocationPageSchema,
  snapshotResultSchema,
  velocitySchema,
} from "./dto/build-reports-response.schemas";

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
  @ResponseSchema(resourceAllocationPageSchema)
  @Validate({ query: resourceAllocationQuerySchema })
  async resourceAllocation(
    @Query() query: ResourceAllocationQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.reports.authorizeOrganization(u);
    return this.analytics.resourceAllocation(u.orgId, query);
  }

  @Get(":projectId/analytics")
  @RequirePermission("build:view")
  @ResponseSchema(analyticsSchema)
  @Validate({ params: projectIdParams, query: projectAnalyticsQuerySchema })
  async getAnalytics(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ProjectAnalyticsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.reports.authorizeProject(u, projectId);
    return this.analytics.getProjectAnalytics(u.orgId, projectId, query);
  }

  @Get(":projectId/reports/burnup")
  @RequirePermission("build:view")
  @ResponseSchema(burnupDataSchema)
  @Validate({ params: projectIdParams, query: burnupQuerySchema })
  burnup(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: BurnupQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.burnup(u, projectId, query);
  }

  @Get(":projectId/reports/cfd")
  @RequirePermission("build:view")
  @ResponseSchema(cfdDataSchema)
  @Validate({ params: projectIdParams, query: cfdQuerySchema })
  cfd(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: CfdQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.cfd(u, projectId, query);
  }

  @Get(":projectId/reports/critical-path")
  @RequirePermission("build:view")
  @ResponseSchema(criticalPathSchema)
  @Validate({ params: projectIdParams })
  criticalPath(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.criticalPath(u, projectId);
  }

  @Get(":projectId/reports/velocity")
  @RequirePermission("build:view")
  @ResponseSchema(velocitySchema)
  @ApiOkResponse({ description: "Most recent cycle page, displayed chronologically; follow Link for older history", headers: {
    "Link": { description: "Relative next-page link for older cycles", schema: { type: "string" } },
    "X-Next-Cursor": { description: "Opaque next-page cursor, empty on the final page", schema: { type: "string" } },
    "X-Has-More": { description: "Whether older cycles exist", schema: { type: "boolean" } },
  } })
  @Validate({ params: projectIdParams, query: velocityQuerySchema })
  async velocity(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
    @Query() query: VelocityQuery,
    @Res({ passthrough: true }) response: Response,
  ) {
    const page = await this.reports.velocity(u, projectId, query);
    response.setHeader("Access-Control-Expose-Headers", "Link, X-Next-Cursor, X-Has-More");
    response.setHeader("X-Has-More", String(page.pagination.hasMore));
    response.setHeader("X-Next-Cursor", page.pagination.nextCursor ?? "");
    if (page.pagination.nextCursor)
      response.setHeader("Link", `</build/${projectId}/reports/velocity?limit=${query.limit}&cursor=${encodeURIComponent(page.pagination.nextCursor)}>; rel="next"`);
    return page.data;
  }

  @Get(":projectId/reports/cycle-time")
  @RequirePermission("build:view")
  @ResponseSchema(cycleTimeSchema)
  @Validate({ params: projectIdParams })
  getCycleTime(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getCycleTimeReport(u, projectId);
  }

  @Get(":projectId/reports/lead-time")
  @RequirePermission("build:view")
  @ResponseSchema(leadTimeSchema)
  @Validate({ params: projectIdParams })
  getLeadTime(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getLeadTimeReport(u, projectId);
  }

  @Post(":projectId/reports/snapshot")
  @BodylessAction()
  @RequirePermission("build:manage")
  @HttpCode(200)
  @ResponseSchema(snapshotResultSchema)
  @Validate({ params: projectIdParams })
  snapshot(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.snapshot(u, projectId);
  }
}
