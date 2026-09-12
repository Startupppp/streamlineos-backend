import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Universal } from "../../common/auth/universal.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AccessService } from "../access/access.service";
import { AccessExplainResolver } from "../access/access-explain.resolver";
import { restrictExplanationTo } from "../access/access-explain-provenance";
import type { DataScope } from "../access/access.types";
import { RolesService } from "./roles.service";
import { RoleSeedService } from "./role-seed.service";
import { RolesQueryService } from "./roles-query.service";
import {
  materializeTemplateSchema,
  type MaterializeTemplateInput,
  listRolesQuerySchema,
  roleMemberSchema,
  setRolePermissionsSchema,
  simulationCandidatesQuerySchema,
  updateRoleSchema,
  type ListRolesQuery,
  type RoleMemberInput,
  type SetRolePermissionsInput,
  type SimulationCandidatesQuery,
  type UpdateRoleInput,
} from "./dto/rbac.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  roleTemplateCatalogResponseSchema,
  seededRolesResponseSchema,
  roleListResponseSchema,
  roleDetailResponseSchema,
  roleAnalyticsResponseSchema,
  permissionsMatrixResponseSchema,
  simulationCandidatesResponseSchema,
  simulateAccessResponseSchema,
  type SimulateAccessResponse,
  materializeTemplateResponseSchema,
  assignableDepartmentsResponseSchema,
  roleMutationResponseSchema,
  rolePermissionsResponseSchema,
  setRolePermissionsResponseSchema,
  roleMembersResponseSchema,
  roleMemberMutationResponseSchema,
} from "./dto/roles-response.schemas";
import { z } from "zod";

const targetUserIdParams = z.object({ targetUserId: z.string().min(1) }).strict();
const roleIdParams = z.object({ roleId: z.string().min(1) }).strict();

@Controller("roles")
@UseGuards(JwtAuthGuard)
export class RolesController {
  constructor(
    private readonly roles: RolesService,
    private readonly seed: RoleSeedService,
    private readonly query: RolesQueryService,
    private readonly access: AccessService,
    private readonly explain: AccessExplainResolver,
  ) {}

  @ResponseSchema(roleListResponseSchema)
  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ query: listRolesQuerySchema })
  list(
    @Query() query: ListRolesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.getRoles(u.orgId, query);
  }

  @ResponseSchema(roleAnalyticsResponseSchema)
  @Get("analytics")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  getAnalytics(@CurrentUser() u: CurrentUserContext) {
    return this.query.getRoleAnalytics(u.orgId);
  }

  @ResponseSchema(permissionsMatrixResponseSchema)
  @Get("permissions/matrix")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  getPermissionsMatrix(@CurrentUser() u: CurrentUserContext) {
    return this.roles.getPermissionsMatrix(u.orgId);
  }

  @ResponseSchema(simulationCandidatesResponseSchema)
  @Get("simulate/candidates")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ query: simulationCandidatesQuerySchema })
  listSimulationCandidates(
    @Query() query: SimulationCandidatesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.query.listSimulationCandidates(u.orgId, query);
  }

  @ResponseSchema(simulateAccessResponseSchema)
  @Get("simulate/:targetUserId")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ params: targetUserIdParams })
  async simulateAccess(
    @Param("targetUserId") targetUserId: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<SimulateAccessResponse> {
    if (!targetUserId) throw new NotFoundException("targetUserId is required");
    const target = await this.query.getSimulationTarget(u.orgId, targetUserId);
    const [resolved, explanation] = await Promise.all([
      this.access.resolveUserPermissions(u.orgId, targetUserId),
      this.explain.explain(u.orgId, targetUserId),
    ]);
    const permissions: string[] = [];
    const scopes: Record<string, DataScope> = {};
    for (const [key, scope] of resolved) {
      if (scope === "none") continue;
      permissions.push(key);
      scopes[key] = scope;
    }
    const restricted = restrictExplanationTo(explanation, scopes);
    return {
      userId: targetUserId,
      permissions,
      scopes,
      isOrgOwner: target.isOwner,
      standing: explanation.standing,
      provenance: restricted.permissions,
      moduleStandings: restricted.moduleStandings,
    };
  }

  @Post("seed-defaults")
  @BodylessAction()
  @HttpCode(200)
  @Idempotent("rbac.roles.seedDefaults")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @ResponseSchema(seededRolesResponseSchema)
  seedDefaults(@CurrentUser() u: CurrentUserContext) {
    return this.seed.seedDefaultRoles(u.orgId);
  }

  @ResponseSchema(materializeTemplateResponseSchema)
  @Post("templates")
  @HttpCode(201)
  @Idempotent("rbac.role.materializeTemplate")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ body: materializeTemplateSchema })
  materializeTemplate(
    @Body() body: MaterializeTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.seed.materializeTemplate(u, body.templateId);
  }

  // ROLE_TEMPLATES is a product constant, no actor and no tenant data; materializing one is the gated action.
  @Get("templates")
  @Universal()
  @ResponseSchema(roleTemplateCatalogResponseSchema)
  templates() {
    return this.seed.listTemplates();
  }

  @ResponseSchema(assignableDepartmentsResponseSchema)
  @Get("departments")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  listAssignableDepartments(@CurrentUser() u: CurrentUserContext) {
    return this.query.listAssignableDepartments(u.orgId);
  }

  @ResponseSchema(roleDetailResponseSchema)
  @Get(":roleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ params: roleIdParams })
  get(@Param("roleId") roleId: string, @CurrentUser() u: CurrentUserContext) {
    return this.roles.getRole(u.orgId, this.parseRoleId(roleId));
  }

  @ResponseSchema(roleMutationResponseSchema)
  @Patch(":roleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ params: roleIdParams, body: updateRoleSchema })
  update(
    @Param("roleId") roleId: string,
    @Body() body: UpdateRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.updateRole(u, this.parseRoleId(roleId), body);
  }

  @ResponseSchema(roleMutationResponseSchema)
  @Delete(":roleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ params: roleIdParams })
  remove(
    @Param("roleId") roleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.deleteRole(u, this.parseRoleId(roleId));
  }

  @ResponseSchema(rolePermissionsResponseSchema)
  @Get(":roleId/permissions")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ params: roleIdParams })
  getPermissions(
    @Param("roleId") roleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.getRolePermissions(u.orgId, this.parseRoleId(roleId));
  }

  @ResponseSchema(setRolePermissionsResponseSchema)
  @Put(":roleId/permissions")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ params: roleIdParams, body: setRolePermissionsSchema })
  setPermissions(
    @Param("roleId") roleId: string,
    @Body() body: SetRolePermissionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.setRolePermissions(u, this.parseRoleId(roleId), body);
  }

  @ResponseSchema(roleMembersResponseSchema)
  @Get(":roleId/members")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ params: roleIdParams })
  getMembers(
    @Param("roleId") roleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.getRoleMembers(u.orgId, this.parseRoleId(roleId));
  }

  @ResponseSchema(roleMemberMutationResponseSchema)
  @Post(":roleId/members")
  @HttpCode(201)
  @Idempotent("rbac.role.addMember")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ params: roleIdParams, body: roleMemberSchema })
  addMember(
    @Param("roleId") roleId: string,
    @Body() body: RoleMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.addRoleMember(u, this.parseRoleId(roleId), body);
  }

  @ResponseSchema(roleMemberMutationResponseSchema)
  @Delete(":roleId/members")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ params: roleIdParams, body: roleMemberSchema })
  removeMember(
    @Param("roleId") roleId: string,
    @Body() body: RoleMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.removeRoleMember(u, this.parseRoleId(roleId), body);
  }

  private parseRoleId(raw: string): number {
    const roleId = Number(raw);
    if (!Number.isFinite(roleId)) throw new BadRequestException("Invalid ID");
    return roleId;
  }
}
