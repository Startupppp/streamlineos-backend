import {
  Body,
  Controller,
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
import { readRequestScopedRead } from "../core/read-request-scope";
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
  createOrgLocationSchema,
  updateOrgLocationSchema,
  createCostCenterSchema,
  updateCostCenterSchema,
  listQuerySchema,
  branchOptionsQuerySchema,
  dependencyPreviewParamsSchema,
  type CreateBusinessUnitInput,
  type UpdateBusinessUnitInput,
  type CreateOrgBranchInput,
  type UpdateOrgBranchInput,
  type CreateOrgDepartmentInput,
  type UpdateOrgDepartmentInput,
  type CreateOrgTeamInput,
  type UpdateOrgTeamInput,
  type CreateOrgLocationInput,
  type UpdateOrgLocationInput,
  type CreateCostCenterInput,
  type UpdateCostCenterInput,
  type ListQueryInput,
  type BranchOptionsQueryInput,
  type DependencyPreviewParamsInput,
} from "./dto/org-hierarchy.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  hierarchyOverviewResponseSchema,
  hierarchyTreeResponseSchema,
  dependencyPreviewResponseSchema,
  businessUnitListResponseSchema,
  businessUnitResponseSchema,
  branchListResponseSchema,
  branchResponseSchema,
  departmentListResponseSchema,
  departmentResponseSchema,
  teamListResponseSchema,
  teamResponseSchema,
  locationListResponseSchema,
  locationResponseSchema,
  costCenterListResponseSchema,
  costCenterResponseSchema,
} from "./dto/org-hierarchy-response.schemas";
import {
  businessUnitIdParams,
  branchIdParams,
  departmentIdParams,
  teamIdParams,
  locationIdParams,
  costCenterIdParams,
} from "./org-hierarchy-params";

@Controller("org-hierarchy")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OrgHierarchyController {
  constructor(private readonly service: OrgHierarchyService) {}

  @RequirePermission("settings:view")
  @Get("overview")
  @ResponseSchema(hierarchyOverviewResponseSchema)
  getHierarchy(
    @CurrentUser() currentUser: CurrentUserContext,
    @Req() request: Request,
  ) {
    return this.service.getHierarchy(currentUser.orgId, {
      discriminator: readRequestScopedRead(request, currentUser).discriminator,
    });
  }

  @RequirePermission("settings:view")
  @Get("tree")
  @ResponseSchema(hierarchyTreeResponseSchema)
  getTree(
    @CurrentUser() currentUser: CurrentUserContext,
    @Req() request: Request,
  ) {
    return this.service.getTree(currentUser.orgId, {
      discriminator: readRequestScopedRead(request, currentUser).discriminator,
    });
  }

  @RequirePermission("settings:view")
  @Get("dependencies/:unitKind/:unitId")
  @ResponseSchema(dependencyPreviewResponseSchema)
  @Validate({ params: dependencyPreviewParamsSchema })
  getDependencyPreview(
    @Param() params: DependencyPreviewParamsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getDependencyPreview(
      u.orgId,
      params.unitId,
      params.unitKind,
    );
  }

  // ─── Business Units ─────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("business-units")
  @ResponseSchema(businessUnitListResponseSchema)
  @Validate({ query: listQuerySchema })
  listBusinessUnits(
    @Query() query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listBusinessUnits(u.orgId, query);
  }

  @Post("business-units")
  @ResponseSchema(businessUnitResponseSchema)
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
  @ResponseSchema(businessUnitResponseSchema)
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

  // ─── Org Branches ───────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("branches")
  @ResponseSchema(branchListResponseSchema)
  @Validate({ query: listQuerySchema })
  listOrgBranches(
    @Query() query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listOrgBranches(u.orgId, query);
  }

  // The dropdown door onto the same rows. `branch:view` is an employee-self-service grant, so a form that only needs branch choices never has to hold `settings:view`.
  @RequirePermission("branch:view")
  @Get("branches/options")
  @ResponseSchema(branchListResponseSchema)
  @Validate({ query: branchOptionsQuerySchema })
  listOrgBranchOptions(
    @Query() query: BranchOptionsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listOrgBranchOptions(u.orgId, query);
  }

  @Post("branches")
  @ResponseSchema(branchResponseSchema)
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
  @ResponseSchema(branchResponseSchema)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: branchIdParams, body: updateOrgBranchSchema })
  updateOrgBranch(
    @Param("branchId") branchId: string,
    @Body() body: UpdateOrgBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateOrgBranch(u.orgId, u.userId, branchId, body);
  }

  // ─── Departments ────────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("departments")
  @ResponseSchema(departmentListResponseSchema)
  @Validate({ query: listQuerySchema })
  listDepartments(
    @Query() query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listDepartments(u.orgId, query);
  }

  @Post("departments")
  @ResponseSchema(departmentResponseSchema)
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
  @ResponseSchema(departmentResponseSchema)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: departmentIdParams, body: updateOrgDepartmentSchema })
  updateDepartment(
    @Param("departmentId") departmentId: string,
    @Body() body: UpdateOrgDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateDepartment(u.orgId, u.userId, departmentId, body);
  }

  // ─── Teams ──────────────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("teams")
  @ResponseSchema(teamListResponseSchema)
  @Validate({ query: listQuerySchema })
  listTeams(
    @Query() query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listTeams(u.orgId, query);
  }

  @Post("teams")
  @ResponseSchema(teamResponseSchema)
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
  @ResponseSchema(teamResponseSchema)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: teamIdParams, body: updateOrgTeamSchema })
  updateTeam(
    @Param("teamId") teamId: string,
    @Body() body: UpdateOrgTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateTeam(u.orgId, u.userId, teamId, body);
  }

  // ─── Locations ──────────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("locations")
  @ResponseSchema(locationListResponseSchema)
  @Validate({ query: listQuerySchema })
  listLocations(
    @Query() query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listLocations(u.orgId, query);
  }

  @Post("locations")
  @ResponseSchema(locationResponseSchema)
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
  @ResponseSchema(locationResponseSchema)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: locationIdParams, body: updateOrgLocationSchema })
  updateLocation(
    @Param("locationId") locationId: string,
    @Body() body: UpdateOrgLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateLocation(u.orgId, u.userId, locationId, body);
  }

  // ─── Cost Centers ────────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("cost-centers")
  @ResponseSchema(costCenterListResponseSchema)
  @Validate({ query: listQuerySchema })
  listCostCenters(
    @Query() query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listCostCenters(u.orgId, query);
  }

  @Post("cost-centers")
  @ResponseSchema(costCenterResponseSchema)
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
  @ResponseSchema(costCenterResponseSchema)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: costCenterIdParams, body: updateCostCenterSchema })
  updateCostCenter(
    @Param("costCenterId") costCenterId: string,
    @Body() body: UpdateCostCenterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateCostCenter(u.orgId, u.userId, costCenterId, body);
  }
}
