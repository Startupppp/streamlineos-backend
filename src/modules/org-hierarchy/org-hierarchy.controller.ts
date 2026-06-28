import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
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

function assertCanManage(u: CurrentUserContext) {
  const ability = defineAbilityFor(u);
  if (!ability.can("manage", "settings")) {
    throw new ForbiddenException("Insufficient permissions");
  }
}

@Controller("org-hierarchy")
@UseGuards(JwtAuthGuard)
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
  createBusinessUnit(
    @Body(new ZodValidationPipe(createBusinessUnitSchema)) body: CreateBusinessUnitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
    return this.service.createBusinessUnit(u.orgId, u.userId, body);
  }

  @Patch("business-units/:id")
  updateBusinessUnit(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateBusinessUnitSchema)) body: UpdateBusinessUnitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
    return this.service.updateBusinessUnit(u.orgId, u.userId, id, body);
  }

  @Delete("business-units/:id")
  async deleteBusinessUnit(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
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
  createOrgBranch(
    @Body(new ZodValidationPipe(createOrgBranchSchema)) body: CreateOrgBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
    return this.service.createOrgBranch(u.orgId, u.userId, body);
  }

  @Patch("branches/:id")
  updateOrgBranch(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrgBranchSchema)) body: UpdateOrgBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
    return this.service.updateOrgBranch(u.orgId, u.userId, id, body);
  }

  @Delete("branches/:id")
  async deleteOrgBranch(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
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
  createDepartment(
    @Body(new ZodValidationPipe(createOrgDepartmentSchema)) body: CreateOrgDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
    return this.service.createDepartment(u.orgId, u.userId, body);
  }

  @Patch("departments/:id")
  updateDepartment(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrgDepartmentSchema)) body: UpdateOrgDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
    return this.service.updateDepartment(u.orgId, u.userId, id, body);
  }

  @Delete("departments/:id")
  async deleteDepartment(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
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
  createTeam(
    @Body(new ZodValidationPipe(createOrgTeamSchema)) body: CreateOrgTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
    return this.service.createTeam(u.orgId, u.userId, body);
  }

  @Patch("teams/:id")
  updateTeam(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrgTeamSchema)) body: UpdateOrgTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
    return this.service.updateTeam(u.orgId, u.userId, id, body);
  }

  @Delete("teams/:id")
  async deleteTeam(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
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
  createLocation(
    @Body(new ZodValidationPipe(createOrgLocationSchema)) body: CreateOrgLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
    return this.service.createLocation(u.orgId, u.userId, body);
  }

  @Patch("locations/:id")
  updateLocation(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrgLocationSchema)) body: UpdateOrgLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
    return this.service.updateLocation(u.orgId, u.userId, id, body);
  }

  @Delete("locations/:id")
  async deleteLocation(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
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
  createCostCenter(
    @Body(new ZodValidationPipe(createCostCenterSchema)) body: CreateCostCenterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
    return this.service.createCostCenter(u.orgId, u.userId, body);
  }

  @Patch("cost-centers/:id")
  updateCostCenter(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateCostCenterSchema)) body: UpdateCostCenterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
    return this.service.updateCostCenter(u.orgId, u.userId, id, body);
  }

  @Delete("cost-centers/:id")
  async deleteCostCenter(
    @Param("id") id: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertCanManage(u);
    await this.service.deleteCostCenter(u.orgId, u.userId, id);
    return { message: "Cost center deleted" };
  }
}
