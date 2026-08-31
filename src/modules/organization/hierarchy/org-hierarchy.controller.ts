import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { readRequestScope } from "../core/read-request-scope";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { OrgHierarchyService } from "./org-hierarchy.service";
import {
  createBusinessUnitSchema,
  updateBusinessUnitSchema,
  createOrgBranchSchema,
  updateOrgBranchSchema,
  createOrgDepartmentSchema,
  updateOrgDepartmentSchema,
  createOrgTeamSchema,
  updateOrgTeamSchema,
  moveOrgTeamSchema,
  moveBusinessUnitSchema,
  moveOrgBranchSchema,
  moveOrgDepartmentSchema,
  createOrgLocationSchema,
  updateOrgLocationSchema,
  createCostCenterSchema,
  updateCostCenterSchema,
  listQuerySchema,
  dependencyPreviewParamsSchema,
  dependencyPreviewQuerySchema,
  type CreateBusinessUnitInput,
  type UpdateBusinessUnitInput,
  type CreateOrgBranchInput,
  type UpdateOrgBranchInput,
  type CreateOrgDepartmentInput,
  type UpdateOrgDepartmentInput,
  type CreateOrgTeamInput,
  type UpdateOrgTeamInput,
  type MoveOrgTeamInput,
  type MoveBusinessUnitInput,
  type MoveOrgBranchInput,
  type MoveOrgDepartmentInput,
  type CreateOrgLocationInput,
  type UpdateOrgLocationInput,
  type CreateCostCenterInput,
  type UpdateCostCenterInput,
  type ListQueryInput,
  type DependencyPreviewParamsInput,
  type DependencyPreviewQueryInput,
} from "./dto/org-hierarchy.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const businessUnitIdParams = z.object({ businessUnitId: z.string().min(1) }).strict();
const branchIdParams = z.object({ branchId: z.string().min(1) }).strict();
const departmentIdParams = z.object({ departmentId: z.string().min(1) }).strict();
const teamIdParams = z.object({ teamId: z.string().min(1) }).strict();
const locationIdParams = z.object({ locationId: z.string().min(1) }).strict();
const costCenterIdParams = z.object({ costCenterId: z.string().min(1) }).strict();

@Controller("org-hierarchy")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OrgHierarchyController {
  constructor(private readonly service: OrgHierarchyService) {}

  @RequirePermission("settings:view")
  @Get("overview")
  getHierarchy(
    @CurrentUser() currentUser: CurrentUserContext,
    @Req() request: Request,
  ) {
    return this.service.getHierarchy(currentUser.orgId, {
      actorUserId: currentUser.userId,
      scope: readRequestScope(request),
    });
  }

  @RequirePermission("settings:view")
  @Get("tree")
  getTree(
    @CurrentUser() currentUser: CurrentUserContext,
    @Req() request: Request,
  ) {
    return this.service.getTree(currentUser.orgId, {
      actorUserId: currentUser.userId,
      scope: readRequestScope(request),
    });
  }

  @RequirePermission("settings:view")
  @Get("dependencies/:unitKind/:unitId")
  @Validate({ params: dependencyPreviewParamsSchema, query: dependencyPreviewQuerySchema })
  getDependencyPreview(
    @Param() params: DependencyPreviewParamsInput,
    @Query() query: DependencyPreviewQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getDependencyPreview(
      u.orgId,
      params.unitId,
      params.unitKind,
      query.mode,
    );
  }

  // ─── Business Units ─────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("business-units")
  @Validate({ query: listQuerySchema })
  listBusinessUnits(
    @Query() query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listBusinessUnits(u.orgId, query);
  }

  @Post("business-units")
  @HttpCode(201)
  @RequirePermission("settings:organization:manage")
  @Validate({ body: createBusinessUnitSchema })
  createBusinessUnit(
    @Body() body: CreateBusinessUnitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createBusinessUnit(u.orgId, u.userId, body);
  }

  @Patch("business-units/:businessUnitId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: businessUnitIdParams, body: updateBusinessUnitSchema })
  updateBusinessUnit(
    @Param("businessUnitId") businessUnitId: string,
    @Body() body: UpdateBusinessUnitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateBusinessUnit(
      u.orgId,
      u.userId,
      businessUnitId,
      body,
    );
  }

  @Delete("business-units/:businessUnitId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: businessUnitIdParams })
  async deleteBusinessUnit(
    @Param("businessUnitId") businessUnitId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteBusinessUnit(u.orgId, u.userId, businessUnitId);
    return { message: "Business unit retired; its history was preserved" };
  }

  // ─── Org Branches ───────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("branches")
  @Validate({ query: listQuerySchema })
  listOrgBranches(
    @Query() query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listOrgBranches(u.orgId, query);
  }

  @Post("branches")
  @HttpCode(201)
  @RequirePermission("settings:organization:manage")
  @Validate({ body: createOrgBranchSchema })
  createOrgBranch(
    @Body() body: CreateOrgBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createOrgBranch(u.orgId, u.userId, body);
  }

  @Patch("branches/:branchId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: branchIdParams, body: updateOrgBranchSchema })
  updateOrgBranch(
    @Param("branchId") branchId: string,
    @Body() body: UpdateOrgBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateOrgBranch(u.orgId, u.userId, branchId, body);
  }

  @Delete("branches/:branchId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: branchIdParams })
  async deleteOrgBranch(
    @Param("branchId") branchId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteOrgBranch(u.orgId, u.userId, branchId);
    return { message: "Branch retired; its history was preserved" };
  }

  // ─── Departments ────────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("departments")
  @Validate({ query: listQuerySchema })
  listDepartments(
    @Query() query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listDepartments(u.orgId, query);
  }

  @Post("departments")
  @HttpCode(201)
  @RequirePermission("settings:organization:manage")
  @Validate({ body: createOrgDepartmentSchema })
  createDepartment(
    @Body() body: CreateOrgDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createDepartment(u.orgId, u.userId, body);
  }

  @Patch("departments/:departmentId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: departmentIdParams, body: updateOrgDepartmentSchema })
  updateDepartment(
    @Param("departmentId") departmentId: string,
    @Body() body: UpdateOrgDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateDepartment(u.orgId, u.userId, departmentId, body);
  }

  @Delete("departments/:departmentId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: departmentIdParams })
  async deleteDepartment(
    @Param("departmentId") departmentId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteDepartment(u.orgId, u.userId, departmentId);
    return { message: "Department retired; its history was preserved" };
  }

  // ─── Teams ──────────────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("teams")
  @Validate({ query: listQuerySchema })
  listTeams(
    @Query() query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listTeams(u.orgId, query);
  }

  @Post("teams")
  @HttpCode(201)
  @RequirePermission("settings:organization:manage")
  @Validate({ body: createOrgTeamSchema })
  createTeam(
    @Body() body: CreateOrgTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createTeam(u.orgId, u.userId, body);
  }

  @Patch("teams/:teamId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: teamIdParams, body: updateOrgTeamSchema })
  updateTeam(
    @Param("teamId") teamId: string,
    @Body() body: UpdateOrgTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateTeam(u.orgId, u.userId, teamId, body);
  }

  @Delete("teams/:teamId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: teamIdParams })
  async deleteTeam(
    @Param("teamId") teamId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteTeam(u.orgId, u.userId, teamId);
    return { message: "Team retired; its history was preserved" };
  }

  // ─── Locations ──────────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("locations")
  @Validate({ query: listQuerySchema })
  listLocations(
    @Query() query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listLocations(u.orgId, query);
  }

  @Post("locations")
  @HttpCode(201)
  @RequirePermission("settings:organization:manage")
  @Validate({ body: createOrgLocationSchema })
  createLocation(
    @Body() body: CreateOrgLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createLocation(u.orgId, u.userId, body);
  }

  @Patch("locations/:locationId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: locationIdParams, body: updateOrgLocationSchema })
  updateLocation(
    @Param("locationId") locationId: string,
    @Body() body: UpdateOrgLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateLocation(u.orgId, u.userId, locationId, body);
  }

  @Delete("locations/:locationId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: locationIdParams })
  async deleteLocation(
    @Param("locationId") locationId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteLocation(u.orgId, u.userId, locationId);
    return { message: "Location retired; its history was preserved" };
  }

  // ─── Cost Centers ────────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("cost-centers")
  @Validate({ query: listQuerySchema })
  listCostCenters(
    @Query() query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listCostCenters(u.orgId, query);
  }

  @Post("cost-centers")
  @HttpCode(201)
  @RequirePermission("settings:organization:manage")
  @Validate({ body: createCostCenterSchema })
  createCostCenter(
    @Body() body: CreateCostCenterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createCostCenter(u.orgId, u.userId, body);
  }

  @Patch("cost-centers/:costCenterId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: costCenterIdParams, body: updateCostCenterSchema })
  updateCostCenter(
    @Param("costCenterId") costCenterId: string,
    @Body() body: UpdateCostCenterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateCostCenter(u.orgId, u.userId, costCenterId, body);
  }

  @Delete("cost-centers/:costCenterId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: costCenterIdParams })
  async deleteCostCenter(
    @Param("costCenterId") costCenterId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteCostCenter(u.orgId, u.userId, costCenterId);
    return { message: "Cost center retired; its history was preserved" };
  }

  @Patch("business-units/:businessUnitId/move")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: businessUnitIdParams, body: moveBusinessUnitSchema })
  moveBusinessUnit(
    @Param("businessUnitId") businessUnitId: string,
    @Body() body: MoveBusinessUnitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveBusinessUnit(
      u.orgId,
      businessUnitId,
      body.parentId ?? null,
    );
  }

  @Patch("branches/:branchId/move")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: branchIdParams, body: moveOrgBranchSchema })
  moveBranch(
    @Param("branchId") branchId: string,
    @Body() body: MoveOrgBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveBranch(
      u.orgId,
      branchId,
      body.businessUnitId ?? null,
    );
  }

  @Patch("departments/:departmentId/move")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: departmentIdParams, body: moveOrgDepartmentSchema })
  moveDepartment(
    @Param("departmentId") departmentId: string,
    @Body() body: MoveOrgDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveDepartment(
      u.orgId,
      departmentId,
      body.branchId ?? null,
    );
  }

  @Patch("teams/:teamId/move")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: teamIdParams, body: moveOrgTeamSchema })
  moveTeam(
    @Param("teamId") teamId: string,
    @Body() body: MoveOrgTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveTeam(u.orgId, teamId, body.departmentId);
  }
}
