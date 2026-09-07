import { Controller, Get, HttpCode, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts"
import { listKpisResponseSchema, createKpiResponseSchema, updateKpiResponseSchema, listFrameworksResponseSchema, createFrameworkResponseSchema, updateFrameworkResponseSchema, listCompetenciesResponseSchema, createCompetencyResponseSchema } from "./dto/kpis-response.schemas"

const kpiIdParams = z.object({ kpiId: z.coerce.number().int().positive() }).strict();
const frameworkIdParams = z.object({ frameworkId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/kpis")
export class KpisController {
  constructor(private readonly service: KpisService) {}

  @ResponseSchema(listKpisResponseSchema)
  @Get()
  @RequirePermission("hr:performance:view")
  listKpis(@CurrentUser() u: CurrentUserContext) {
    return this.service.listKpis(u.orgId);
  }

  @ResponseSchema(createKpiResponseSchema)
  @Post()
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  @Validate({ body: createKpiSchema })
  createKpi(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateKpiInput,
  ) {
    return this.service.createKpi(u.orgId, body);
  }

  @ResponseSchema(updateKpiResponseSchema)
  @Patch(":kpiId")
  @RequirePermission("hr:performance:manage")
  @Validate({ params: kpiIdParams, body: updateKpiSchema })
  updateKpi(
    @CurrentUser() u: CurrentUserContext,
    @Param("kpiId", ParseIntPipe) kpiId: number,
    @Body() body: UpdateKpiInput,
  ) {
    return this.service.updateKpi(u.orgId, kpiId, body);
  }

  @NoContentResponse()
  @Delete(":kpiId")
  @HttpCode(204)
  @RequirePermission("hr:performance:manage")
  @Validate({ params: kpiIdParams })
  async deleteKpi(@CurrentUser() u: CurrentUserContext, @Param("kpiId", ParseIntPipe) kpiId: number) {
    await this.service.deleteKpi(u.orgId, kpiId);
  }

  @ResponseSchema(listFrameworksResponseSchema)
  @Get("frameworks")
  @RequirePermission("hr:performance:view")
  listFrameworks(@CurrentUser() u: CurrentUserContext) {
    return this.service.listFrameworks(u.orgId);
  }

  @ResponseSchema(createFrameworkResponseSchema)
  @Post("frameworks")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  @Validate({ body: createFrameworkSchema })
  createFramework(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateFrameworkInput,
  ) {
    return this.service.createFramework(u.orgId, body);
  }

  @ResponseSchema(updateFrameworkResponseSchema)
  @Patch("frameworks/:frameworkId")
  @RequirePermission("hr:performance:manage")
  @Validate({ params: frameworkIdParams, body: updateFrameworkSchema })
  updateFramework(
    @CurrentUser() u: CurrentUserContext,
    @Param("frameworkId", ParseIntPipe) frameworkId: number,
    @Body() body: UpdateFrameworkInput,
  ) {
    return this.service.updateFramework(u.orgId, frameworkId, body);
  }

  @ResponseSchema(listCompetenciesResponseSchema)
  @Get("frameworks/:frameworkId/competencies")
  @RequirePermission("hr:performance:view")
  @Validate({ params: frameworkIdParams })
  listCompetencies(@Param("frameworkId", ParseIntPipe) frameworkId: number, @CurrentUser() u: CurrentUserContext) {
    return this.service.listCompetencies(u.orgId, frameworkId);
  }

  @ResponseSchema(createCompetencyResponseSchema)
  @Post("frameworks/:frameworkId/competencies")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  @Validate({ params: frameworkIdParams, body: createCompetencySchema })
  createCompetency(
    @Param("frameworkId", ParseIntPipe) frameworkId: number,
    @Body() body: CreateCompetencyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createCompetency(u.orgId, frameworkId, body);
  }
}
