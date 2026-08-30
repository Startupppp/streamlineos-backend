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
import type { DataScope } from "../access/access.types";
import { RolesService } from "./roles.service";
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
import { z } from "zod";

const targetUserIdParams = z.object({ targetUserId: z.string().min(1) }).strict();
const roleIdParams = z.object({ roleId: z.string().min(1) }).strict();

interface SimulateAccessResponse {
  userId: string;
  permissions: string[];
  scopes: Record<string, DataScope>;
  isOrgOwner: boolean;
}

@Controller("roles")
@UseGuards(JwtAuthGuard)
export class RolesController {
  constructor(
    private readonly roles: RolesService,
    private readonly query: RolesQueryService,
    private readonly access: AccessService,
  ) {}

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

  @Get("analytics")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  getAnalytics(@CurrentUser() u: CurrentUserContext) {
    return this.query.getRoleAnalytics(u.orgId);
  }

  @Get("permissions/matrix")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  getPermissionsMatrix(@CurrentUser() u: CurrentUserContext) {
    return this.roles.getPermissionsMatrix(u.orgId);
  }

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
    const resolved = await this.access.resolveUserPermissions(
      u.orgId,
      targetUserId,
    );
    const permissions: string[] = [];
    const scopes: Record<string, DataScope> = {};
    for (const [key, scope] of resolved) {
      if (scope === "none") continue;
      permissions.push(key);
      scopes[key] = scope;
    }
    return {
      userId: targetUserId,
      permissions,
      scopes,
      isOrgOwner: target.isOwner,
    };
  }

  @Post("seed-defaults")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  seedDefaults(@CurrentUser() u: CurrentUserContext) {
    return this.roles.seedDefaultRoles(u.orgId);
  }

  @Post("templates")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ body: materializeTemplateSchema })
  materializeTemplate(
    @Body() body: MaterializeTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.materializeTemplate(u, body.templateId);
  }

  // ROLE_TEMPLATES is a product constant, no actor and no tenant data; materializing one is the gated action.
  @Get("templates")
  @Universal()
  templates() {
    return this.roles.listTemplates();
  }

  @Get("departments")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  listAssignableDepartments(@CurrentUser() u: CurrentUserContext) {
    return this.query.listAssignableDepartments(u.orgId);
  }

  @Get(":roleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ params: roleIdParams })
  get(@Param("roleId") roleId: string, @CurrentUser() u: CurrentUserContext) {
    return this.roles.getRole(u.orgId, this.parseRoleId(roleId));
  }

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

  @Post(":roleId/members")
  @HttpCode(201)
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
