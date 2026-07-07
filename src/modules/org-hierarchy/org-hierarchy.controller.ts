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

  @Get("overview")
  getHierarchy(@CurrentUser() u: CurrentUserContext) {
    return this.service.getHierarchy(u.orgId);
  }

  @Get("tree")
  getTree(@CurrentUser() u: CurrentUserContext) {
    return this.service.getTree(u.orgId);
  }

  // ─── Business Units ─────────────────────────────────────────────────

  @Get("business-units")
  listBusinessUnits(
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listBusinessUnits(u.orgId, query);
  }

  @Post("business-units")
  @HttpCode(201)
  @RequirePermission("settings:org:manage")
  createBusinessUnit(
    @Body(new ZodValidationPipe(createBusinessUnitSchema)) body: CreateBusinessUnitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createBusinessUnit(u.orgId, u.userId, body);
  }

  @Patch("business-units/:id")
  @RequirePermission("settings:org:manage")
  updateBusinessUnit(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateBusinessUnitSchema)) body: UpdateBusinessUnitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateBusinessUnit(u.orgId, u.userId, id, body);
  }

  @Delete("business-units/:id")
  @RequirePermission("settings:org:manage")
  async deleteBusinessUnit(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteBusinessUnit(u.orgId, u.userId, id);
    return { message: "Business unit deleted" };
  }

  // ─── Org Branches ───────────────────────────────────────────────────

  @Get("branches")
  listOrgBranches(
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listOrgBranches(u.orgId, query);
  }

  @Post("branches")
  @HttpCode(201)
  @RequirePermission("settings:org:manage")
  createOrgBranch(
    @Body(new ZodValidationPipe(createOrgBranchSchema)) body: CreateOrgBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createOrgBranch(u.orgId, u.userId, body);
  }

  @Patch("branches/:id")
  @RequirePermission("settings:org:manage")
  updateOrgBranch(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrgBranchSchema)) body: UpdateOrgBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateOrgBranch(u.orgId, u.userId, id, body);
  }

  @Delete("branches/:id")
  @RequirePermission("settings:org:manage")
  async deleteOrgBranch(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteOrgBranch(u.orgId, u.userId, id);
    return { message: "Branch deleted" };
  }

  // ─── Departments ────────────────────────────────────────────────────

  @Get("departments")
  listDepartments(
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listDepartments(u.orgId, query);
  }

  @Post("departments")
  @HttpCode(201)
  @RequirePermission("settings:org:manage")
  createDepartment(
    @Body(new ZodValidationPipe(createOrgDepartmentSchema)) body: CreateOrgDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createDepartment(u.orgId, u.userId, body);
  }

  @Patch("departments/:id")
  @RequirePermission("settings:org:manage")
  updateDepartment(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrgDepartmentSchema)) body: UpdateOrgDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateDepartment(u.orgId, u.userId, id, body);
  }

  @Delete("departments/:id")
  @RequirePermission("settings:org:manage")
  async deleteDepartment(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteDepartment(u.orgId, u.userId, id);
    return { message: "Department deleted" };
  }

  // ─── Teams ──────────────────────────────────────────────────────────

  @Get("teams")
  listTeams(
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listTeams(u.orgId, query);
  }

  @Post("teams")
  @HttpCode(201)
  @RequirePermission("settings:org:manage")
  createTeam(
    @Body(new ZodValidationPipe(createOrgTeamSchema)) body: CreateOrgTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createTeam(u.orgId, u.userId, body);
  }

  @Patch("teams/:id")
  @RequirePermission("settings:org:manage")
  updateTeam(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrgTeamSchema)) body: UpdateOrgTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateTeam(u.orgId, u.userId, id, body);
  }

  @Delete("teams/:id")
  @RequirePermission("settings:org:manage")
  async deleteTeam(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteTeam(u.orgId, u.userId, id);
    return { message: "Team deleted" };
  }

  // ─── Locations ──────────────────────────────────────────────────────

  @Get("locations")
  listLocations(@CurrentUser() u: CurrentUserContext) {
    return this.service.listLocations(u.orgId);
  }

  @Post("locations")
  @HttpCode(201)
  @RequirePermission("settings:org:manage")
  createLocation(
    @Body(new ZodValidationPipe(createOrgLocationSchema)) body: CreateOrgLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createLocation(u.orgId, u.userId, body);
  }

  @Patch("locations/:id")
  @RequirePermission("settings:org:manage")
  updateLocation(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrgLocationSchema)) body: UpdateOrgLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateLocation(u.orgId, u.userId, id, body);
  }

  @Delete("locations/:id")
  @RequirePermission("settings:org:manage")
  async deleteLocation(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteLocation(u.orgId, u.userId, id);
    return { message: "Location deleted" };
  }

  // ─── Cost Centers ────────────────────────────────────────────────────

  @Get("cost-centers")
  listCostCenters(@CurrentUser() u: CurrentUserContext) {
    return this.service.listCostCenters(u.orgId);
  }

  @Post("cost-centers")
  @HttpCode(201)
  @RequirePermission("settings:org:manage")
  createCostCenter(
    @Body(new ZodValidationPipe(createCostCenterSchema)) body: CreateCostCenterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createCostCenter(u.orgId, u.userId, body);
  }

  @Patch("cost-centers/:id")
  @RequirePermission("settings:org:manage")
  updateCostCenter(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateCostCenterSchema)) body: UpdateCostCenterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateCostCenter(u.orgId, u.userId, id, body);
  }

  @Delete("cost-centers/:id")
  @RequirePermission("settings:org:manage")
  async deleteCostCenter(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.service.deleteCostCenter(u.orgId, u.userId, id);
    return { message: "Cost center deleted" };
  }

  @Patch("business-units/:id/move")
  @RequirePermission("settings:org:manage")
  moveBusinessUnit(
    @Param("id") id: string,
    @Body() body: { parentId: string | null },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveBusinessUnit(u.orgId, id, body.parentId ?? null);
  }

  @Patch("branches/:id/move")
  @RequirePermission("settings:org:manage")
  moveBranch(
    @Param("id") id: string,
    @Body() body: { businessUnitId: string | null },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveBranch(u.orgId, id, body.businessUnitId ?? null);
  }

  @Patch("departments/:id/move")
  @RequirePermission("settings:org:manage")
  moveDepartment(
    @Param("id") id: string,
    @Body() body: { branchId: string | null },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveDepartment(u.orgId, id, body.branchId ?? null);
  }

  @Patch("teams/:id/move")
  @RequirePermission("settings:org:manage")
  moveTeam(
    @Param("id") id: string,
    @Body() body: { departmentId: string | null },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveTeam(u.orgId, id, body.departmentId ?? null);
  }
}
