import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { InvProjectsService } from "./inv-projects.service";
import {
  createProjectSchema,
  createRequirementSchema,
  listProjectsSchema,
  reserveRequirementSchema,
  updateProjectSchema,
  updateRequirementSchema,
} from "./dto/inv-projects.schemas";
import type {
  CreateProjectInput,
  CreateRequirementInput,
  ListProjectsInput,
  ReserveRequirementInput,
  UpdateProjectInput,
  UpdateRequirementInput,
} from "./dto/inv-projects.schemas";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  archiveProjectResponseSchema,
  atRiskRequirementsResponseSchema,
  createProjectResponseSchema,
  createRequirementResponseSchema,
  getProjectResponseSchema,
  listProjectsResponseSchema,
  releaseRequirementResponseSchema,
  reserveRequirementResponseSchema,
  updateProjectResponseSchema,
  updateRequirementResponseSchema,
} from "./dto/inv-projects-response.schemas";

/**
 * B1 — construction projects and the material each site still needs.
 *
 * Reading is `inventory:projects:read` and writing is `inventory:projects:manage`:
 * a site engineer raises requirements, and everybody in inventory can see what a
 * site is waiting for. Reserving stock against a line is deliberately
 * `inventory:stock:reserve` and not the project key — holding stock is a claim on
 * the warehouse, and whoever may make that claim is a warehouse decision, not a
 * project one.
 */
@RequireModule("inventory")
@Controller("inventory/projects")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvProjectsController {
  constructor(private readonly svc: InvProjectsService) {}

  @Get()
  @ResponseSchema(listProjectsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:projects:read")
  list(
    @Query(new ZodValidationPipe(listProjectsSchema)) query: ListProjectsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listProjects(u.orgId, query);
  }

  /**
   * The at-risk feed. Declared before `:projectId` because Nest matches routes in
   * declaration order and `at-risk` would otherwise be parsed as an id.
   */
  @Get("at-risk")
  @ResponseSchema(atRiskRequirementsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:projects:read")
  atRisk(@Query("limit") limit: string | undefined, @CurrentUser() u: CurrentUserContext) {
    const parsed = Number(limit);
    const bounded = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 100) : 25;
    return this.svc.atRiskRequirements(u.orgId, bounded);
  }

  @Get(":projectId")
  @ResponseSchema(getProjectResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:projects:read")
  get(@Param("projectId", ParseIntPipe) projectId: number, @CurrentUser() u: CurrentUserContext) {
    return this.svc.getProject(u.orgId, projectId);
  }

  @Post()
  @ResponseSchema(createProjectResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:projects:manage")
  @Idempotent("inventory.project.create")
  create(
    @Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createProject(u.orgId, u.userId, body);
  }

  @Patch(":projectId")
  @ResponseSchema(updateProjectResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:projects:manage")
  update(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateProject(u.orgId, u.userId, projectId, body);
  }

  @Delete(":projectId")
  @ResponseSchema(archiveProjectResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:projects:manage")
  archive(@Param("projectId", ParseIntPipe) projectId: number, @CurrentUser() u: CurrentUserContext) {
    return this.svc.archiveProject(u.orgId, u.userId, projectId);
  }

  @Post(":projectId/requirements")
  @ResponseSchema(createRequirementResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:projects:manage")
  @Idempotent("inventory.project.requirement.create")
  addRequirement(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createRequirementSchema)) body: CreateRequirementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.addRequirement(u.orgId, u.userId, projectId, body);
  }

  @Patch(":projectId/requirements/:requirementId")
  @ResponseSchema(updateRequirementResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:projects:manage")
  updateRequirement(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("requirementId", ParseIntPipe) requirementId: number,
    @Body(new ZodValidationPipe(updateRequirementSchema)) body: UpdateRequirementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateRequirement(u.orgId, u.userId, projectId, requirementId, body);
  }

  /**
   * Holding stock is a claim on the warehouse, so it carries the warehouse's own
   * key. Idempotent: a double-tapped "Reserve Stock" must not hold the material
   * twice.
   */
  @Post(":projectId/requirements/:requirementId/reserve")
  @ResponseSchema(reserveRequirementResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reserve")
  @Idempotent("inventory.project.requirement.reserve")
  reserve(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("requirementId", ParseIntPipe) requirementId: number,
    @Body(new ZodValidationPipe(reserveRequirementSchema)) body: ReserveRequirementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.reserveRequirement(u.orgId, u.userId, projectId, requirementId, body);
  }

  @Post(":projectId/requirements/:requirementId/release")
  @ResponseSchema(releaseRequirementResponseSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reserve")
  @Idempotent("inventory.project.requirement.release")
  release(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("requirementId", ParseIntPipe) requirementId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.releaseRequirement(u.orgId, u.userId, projectId, requirementId);
  }
}
