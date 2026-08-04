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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
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
  createOrgLocationSchema,
  updateOrgLocationSchema,
  createCostCenterSchema,
  updateCostCenterSchema,
  listQuerySchema,
  type CreateBusinessUnitInput,
  type UpdateBusinessUnitInput,
  type CreateOrgBranchInput,
  type UpdateOrgBranchInput,
  type CreateOrgDepartmentInput,
  type UpdateOrgDepartmentInput,
  type CreateOrgTeamInput,
  type UpdateOrgTeamInput,
  type MoveOrgTeamInput,
  type CreateOrgLocationInput,
  type UpdateOrgLocationInput,
  type CreateCostCenterInput,
  type UpdateCostCenterInput,
  type ListQueryInput,
} from "./dto/org-hierarchy.schemas";

@RequireModule("hr")
@Controller("org-hierarchy")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class OrgHierarchyController {
  constructor(private readonly service: OrgHierarchyService) {}

  @RequirePermission("settings:view")
  @Get("overview")
  getHierarchy(@CurrentUser() u: CurrentUserContext) {
    return this.service.getHierarchy(u.orgId);
  }

  @RequirePermission("settings:view")
  @Get("tree")
  getTree(@CurrentUser() u: CurrentUserContext) {
    return this.service.getTree(u.orgId);
  }

  // ─── Business Units ─────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("business-units")
  listBusinessUnits(
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listBusinessUnits(u.orgId, query);
  }

  @Post("business-units")
  @HttpCode(201)
  @RequirePermission("settings:organization:manage")
  createBusinessUnit(
    @Body(new ZodValidationPipe(createBusinessUnitSchema)) body: CreateBusinessUnitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createBusinessUnit(u.orgId, u.userId, body);
  }

  @Patch("business-units/:businessUnitId")
  @RequirePermission("settings:organization:manage")
  updateBusinessUnit(
    @Param("businessUnitId") businessUnitId: string,
    @Body(new ZodValidationPipe(updateBusinessUnitSchema)) body: UpdateBusinessUnitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateBusinessUnit(u.orgId, u.userId, businessUnitId, body);
  }

  @Delete("business-units/:businessUnitId")
  @RequirePermission("settings:organization:manage")
  async deleteBusinessUnit(
    @Param("businessUnitId") businessUnitId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteBusinessUnit(u.orgId, u.userId, businessUnitId);
    return { message: "Business unit deleted" };
  }

  // ─── Org Branches ───────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("branches")
  listOrgBranches(
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listOrgBranches(u.orgId, query);
  }

  @Post("branches")
  @HttpCode(201)
  @RequirePermission("settings:organization:manage")
  createOrgBranch(
    @Body(new ZodValidationPipe(createOrgBranchSchema)) body: CreateOrgBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createOrgBranch(u.orgId, u.userId, body);
  }

  @Patch("branches/:branchId")
  @RequirePermission("settings:organization:manage")
  updateOrgBranch(
    @Param("branchId") branchId: string,
    @Body(new ZodValidationPipe(updateOrgBranchSchema)) body: UpdateOrgBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateOrgBranch(u.orgId, u.userId, branchId, body);
  }

  @Delete("branches/:branchId")
  @RequirePermission("settings:organization:manage")
  async deleteOrgBranch(
    @Param("branchId") branchId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteOrgBranch(u.orgId, u.userId, branchId);
    return { message: "Branch deleted" };
  }

  // ─── Departments ────────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("departments")
  listDepartments(
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listDepartments(u.orgId, query);
  }

  @Post("departments")
  @HttpCode(201)
  @RequirePermission("settings:organization:manage")
  createDepartment(
    @Body(new ZodValidationPipe(createOrgDepartmentSchema)) body: CreateOrgDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createDepartment(u.orgId, u.userId, body);
  }

  @Patch("departments/:departmentId")
  @RequirePermission("settings:organization:manage")
  updateDepartment(
    @Param("departmentId") departmentId: string,
    @Body(new ZodValidationPipe(updateOrgDepartmentSchema)) body: UpdateOrgDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateDepartment(u.orgId, u.userId, departmentId, body);
  }

  @Delete("departments/:departmentId")
  @RequirePermission("settings:organization:manage")
  async deleteDepartment(
    @Param("departmentId") departmentId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteDepartment(u.orgId, u.userId, departmentId);
    return { message: "Department deleted" };
  }

  // ─── Teams ──────────────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("teams")
  listTeams(
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listTeams(u.orgId, query);
  }

  @Post("teams")
  @HttpCode(201)
  @RequirePermission("settings:organization:manage")
  createTeam(
    @Body(new ZodValidationPipe(createOrgTeamSchema)) body: CreateOrgTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createTeam(u.orgId, u.userId, body);
  }

  @Patch("teams/:teamId")
  @RequirePermission("settings:organization:manage")
  updateTeam(
    @Param("teamId") teamId: string,
    @Body(new ZodValidationPipe(updateOrgTeamSchema)) body: UpdateOrgTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateTeam(u.orgId, u.userId, teamId, body);
  }

  @Delete("teams/:teamId")
  @RequirePermission("settings:organization:manage")
  async deleteTeam(
    @Param("teamId") teamId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteTeam(u.orgId, u.userId, teamId);
    return { message: "Team deleted" };
  }

  // ─── Locations ──────────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("locations")
  listLocations(@CurrentUser() u: CurrentUserContext) {
    return this.service.listLocations(u.orgId);
  }

  @Post("locations")
  @HttpCode(201)
  @RequirePermission("settings:organization:manage")
  createLocation(
    @Body(new ZodValidationPipe(createOrgLocationSchema)) body: CreateOrgLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createLocation(u.orgId, u.userId, body);
  }

  @Patch("locations/:locationId")
  @RequirePermission("settings:organization:manage")
  updateLocation(
    @Param("locationId") locationId: string,
    @Body(new ZodValidationPipe(updateOrgLocationSchema)) body: UpdateOrgLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateLocation(u.orgId, u.userId, locationId, body);
  }

  @Delete("locations/:locationId")
  @RequirePermission("settings:organization:manage")
  async deleteLocation(
    @Param("locationId") locationId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteLocation(u.orgId, u.userId, locationId);
    return { message: "Location deleted" };
  }

  // ─── Cost Centers ────────────────────────────────────────────────────

  @RequirePermission("settings:view")
  @Get("cost-centers")
  listCostCenters(@CurrentUser() u: CurrentUserContext) {
    return this.service.listCostCenters(u.orgId);
  }

  @Post("cost-centers")
  @HttpCode(201)
  @RequirePermission("settings:organization:manage")
  createCostCenter(
    @Body(new ZodValidationPipe(createCostCenterSchema)) body: CreateCostCenterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createCostCenter(u.orgId, u.userId, body);
  }

  @Patch("cost-centers/:costCenterId")
  @RequirePermission("settings:organization:manage")
  updateCostCenter(
    @Param("costCenterId") costCenterId: string,
    @Body(new ZodValidationPipe(updateCostCenterSchema)) body: UpdateCostCenterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateCostCenter(u.orgId, u.userId, costCenterId, body);
  }

  @Delete("cost-centers/:costCenterId")
  @RequirePermission("settings:organization:manage")
  async deleteCostCenter(
    @Param("costCenterId") costCenterId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteCostCenter(u.orgId, u.userId, costCenterId);
    return { message: "Cost center deleted" };
  }

  @Patch("business-units/:businessUnitId/move")
  @RequirePermission("settings:organization:manage")
  moveBusinessUnit(
    @Param("businessUnitId") businessUnitId: string,
    @Body() body: { parentId: string | null },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveBusinessUnit(u.orgId, businessUnitId, body.parentId ?? null);
  }

  @Patch("branches/:branchId/move")
  @RequirePermission("settings:organization:manage")
  moveBranch(
    @Param("branchId") branchId: string,
    @Body() body: { businessUnitId: string | null },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveBranch(u.orgId, branchId, body.businessUnitId ?? null);
  }

  @Patch("departments/:departmentId/move")
  @RequirePermission("settings:organization:manage")
  moveDepartment(
    @Param("departmentId") departmentId: string,
    @Body() body: { branchId: string | null },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveDepartment(u.orgId, departmentId, body.branchId ?? null);
  }

  @Patch("teams/:teamId/move")
  @RequirePermission("settings:organization:manage")
  moveTeam(
    @Param("teamId") teamId: string,
    @Body(new ZodValidationPipe(moveOrgTeamSchema)) body: MoveOrgTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveTeam(u.orgId, teamId, body.departmentId);
  }
}
