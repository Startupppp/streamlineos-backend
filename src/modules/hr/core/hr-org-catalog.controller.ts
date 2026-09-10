import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { HrOrgCatalogService } from "./hr-org-catalog.service";
import { z } from "zod";
import { Validate } from "../../../common/validation/validate.decorator";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import {
  jobRoleRowSchema,
  jobLevelRowSchema,
  headcountItemSchema,
} from "./dto/core-response.schemas";
import {
  createCatalogSchema,
  updateCatalogSchema,
  type CreateCatalogInput,
  type UpdateCatalogInput,
} from "./dto/hr-core.schemas";

const roleIdParams = z.object({ roleId: z.coerce.number().int().positive() }).strict();
const levelIdParams = z.object({ levelId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/org")
@UseGuards(JwtAuthGuard)
export class HrOrgCatalogController {
  constructor(private readonly catalog: HrOrgCatalogService) {}

  @Get("roles")
  @ResponseSchema(z.array(jobRoleRowSchema))
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  listJobRoles(@CurrentUser() u: CurrentUserContext) {
    return this.catalog.listJobRoles(u.orgId);
  }

  @Post("roles")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  @ResponseSchema(jobRoleRowSchema)
  @Validate({ body: createCatalogSchema })
  createJobRole(
    @Body() body: CreateCatalogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.createJobRole(u.orgId, body);
  }

  @Patch("roles/:roleId")
  @ResponseSchema(jobRoleRowSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: roleIdParams, body: updateCatalogSchema })
  updateJobRole(
    @Param("roleId", ParseIntPipe) roleId: number,
    @Body() body: UpdateCatalogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.updateJobRole(u.orgId, roleId, body);
  }

  @Delete("roles/:roleId")
  @HttpCode(204)
  @NoContentResponse()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: roleIdParams })
  deleteJobRole(
    @Param("roleId", ParseIntPipe) roleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.deleteJobRole(u.orgId, roleId);
  }

  @Get("levels")
  @ResponseSchema(z.array(jobLevelRowSchema))
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  listJobLevels(@CurrentUser() u: CurrentUserContext) {
    return this.catalog.listJobLevels(u.orgId);
  }

  @Post("levels")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  @ResponseSchema(jobLevelRowSchema)
  @Validate({ body: createCatalogSchema })
  createJobLevel(
    @Body() body: CreateCatalogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.createJobLevel(u.orgId, body);
  }

  @Patch("levels/:levelId")
  @ResponseSchema(jobLevelRowSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: levelIdParams, body: updateCatalogSchema })
  updateJobLevel(
    @Param("levelId", ParseIntPipe) levelId: number,
    @Body() body: UpdateCatalogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.updateJobLevel(u.orgId, levelId, body);
  }

  @Delete("levels/:levelId")
  @HttpCode(204)
  @NoContentResponse()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: levelIdParams })
  deleteJobLevel(
    @Param("levelId", ParseIntPipe) levelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.deleteJobLevel(u.orgId, levelId);
  }

  @Get("headcount")
  @ResponseSchema(z.array(headcountItemSchema))
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  getHeadcount(
    @Query("groupBy") groupBy: string = "department",
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.getHeadcount(u.orgId, groupBy);
  }
}
