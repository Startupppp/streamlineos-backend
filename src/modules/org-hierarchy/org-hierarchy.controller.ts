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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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
} from "./dto/org-hierarchy.schemas";

@RequireModule("HR")
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

  @Patch("business-units/:id")
  @RequirePermission("settings:organization:manage")
  updateBusinessUnit(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateBusinessUnitSchema)) body: UpdateBusinessUnitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateBusinessUnit(u.orgId, u.userId, id, body);
  }

  @Delete("business-units/:id")
  @RequirePermission("settings:organization:manage")
  async deleteBusinessUnit(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteBusinessUnit(u.orgId, u.userId, id);
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

  @Patch("branches/:id")
  @RequirePermission("settings:organization:manage")
  updateOrgBranch(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrgBranchSchema)) body: UpdateOrgBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateOrgBranch(u.orgId, u.userId, id, body);
  }

  @Delete("branches/:id")
  @RequirePermission("settings:organization:manage")
  async deleteOrgBranch(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteOrgBranch(u.orgId, u.userId, id);
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

  @Patch("departments/:id")
  @RequirePermission("settings:organization:manage")
  updateDepartment(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrgDepartmentSchema)) body: UpdateOrgDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateDepartment(u.orgId, u.userId, id, body);
  }

  @Delete("departments/:id")
  @RequirePermission("settings:organization:manage")
  async deleteDepartment(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteDepartment(u.orgId, u.userId, id);
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

  @Patch("teams/:id")
  @RequirePermission("settings:organization:manage")
  updateTeam(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrgTeamSchema)) body: UpdateOrgTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateTeam(u.orgId, u.userId, id, body);
  }

  @Delete("teams/:id")
  @RequirePermission("settings:organization:manage")
  async deleteTeam(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteTeam(u.orgId, u.userId, id);
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

  @Patch("locations/:id")
  @RequirePermission("settings:organization:manage")
  updateLocation(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrgLocationSchema)) body: UpdateOrgLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateLocation(u.orgId, u.userId, id, body);
  }

  @Delete("locations/:id")
  @RequirePermission("settings:organization:manage")
  async deleteLocation(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteLocation(u.orgId, u.userId, id);
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

  @Patch("cost-centers/:id")
  @RequirePermission("settings:organization:manage")
  updateCostCenter(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateCostCenterSchema)) body: UpdateCostCenterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateCostCenter(u.orgId, u.userId, id, body);
  }

  @Delete("cost-centers/:id")
  @RequirePermission("settings:organization:manage")
  async deleteCostCenter(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteCostCenter(u.orgId, u.userId, id);
    return { message: "Cost center deleted" };
  }

  @Patch("business-units/:id/move")
  @RequirePermission("settings:organization:manage")
  moveBusinessUnit(
    @Param("id") id: string,
    @Body() body: { parentId: string | null },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveBusinessUnit(u.orgId, id, body.parentId ?? null);
  }

  @Patch("branches/:id/move")
  @RequirePermission("settings:organization:manage")
  moveBranch(
    @Param("id") id: string,
    @Body() body: { businessUnitId: string | null },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveBranch(u.orgId, id, body.businessUnitId ?? null);
  }

  @Patch("departments/:id/move")
  @RequirePermission("settings:organization:manage")
  moveDepartment(
    @Param("id") id: string,
    @Body() body: { branchId: string | null },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveDepartment(u.orgId, id, body.branchId ?? null);
  }

  @Patch("teams/:id/move")
  @RequirePermission("settings:organization:manage")
  moveTeam(
    @Param("id") id: string,
    @Body() body: { departmentId: string | null },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveTeam(u.orgId, id, body.departmentId ?? null);
  }
}
