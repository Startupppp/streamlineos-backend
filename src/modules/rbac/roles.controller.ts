import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AccessService } from "../access/access.service";
import type { DataScope } from "../access/access.types";
import { RolesService } from "./roles.service";
import {
  cloneTemplateSchema,
  createRoleSchema,
  roleMemberSchema,
  setRolePermissionsSchema,
  updateRoleSchema,
  type CloneTemplateInput,
  type CreateRoleInput,
  type RoleMemberInput,
  type SetRolePermissionsInput,
  type UpdateRoleInput,
} from "./dto/rbac.schemas";

interface SimulateAccessResponse {
  userId: string;
  permissions: string[];
  scopes: Record<string, DataScope>;
  isOrgOwner: boolean;
}

@Controller("roles")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RolesController {
  constructor(
    private readonly roles: RolesService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("settings:rbac:manage")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.roles.getRoles(u.orgId);
  }

  @Post()
  @RequirePermission("settings:rbac:manage")
  create(
    @Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.createRole(u, body);
  }

  @Get("permissions/matrix")
  @RequirePermission("settings:rbac:manage")
  getPermissionsMatrix(@CurrentUser() u: CurrentUserContext) {
    return this.roles.getPermissionsMatrix(u.orgId);
  }

  @Get("simulate/:targetUserId")
  @RequirePermission("settings:rbac:manage")
  async simulateAccess(
    @Param("targetUserId") targetUserId: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<SimulateAccessResponse> {
    if (!targetUserId) throw new NotFoundException("targetUserId is required");
    const resolved = await this.access.resolveUserPermissions(u.orgId, targetUserId);
    const permissions: string[] = [];
    const scopes: Record<string, DataScope> = {};
    for (const [key, scope] of resolved) {
      if (scope === "none") continue;
      permissions.push(key);
      scopes[key] = scope;
    }
    return { userId: targetUserId, permissions, scopes, isOrgOwner: false };
  }

  @Get("templates")
  templates() {
    return this.roles.listTemplates();
  }

  @Post("templates")
  @RequirePermission("settings:rbac:manage")
  cloneTemplate(
    @Body(new ZodValidationPipe(cloneTemplateSchema)) body: CloneTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.cloneTemplate(u, body);
  }

  @Get(":roleId")
  @RequirePermission("settings:rbac:manage")
  get(@Param("roleId") roleId: string, @CurrentUser() u: CurrentUserContext) {
    return this.roles.getRole(u.orgId, this.parseRoleId(roleId));
  }

  @Patch(":roleId")
  @RequirePermission("settings:rbac:manage")
  update(
    @Param("roleId") roleId: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.updateRole(u, this.parseRoleId(roleId), body);
  }

  @Delete(":roleId")
  @RequirePermission("settings:rbac:manage")
  remove(@Param("roleId") roleId: string, @CurrentUser() u: CurrentUserContext) {
    return this.roles.deleteRole(u, this.parseRoleId(roleId));
  }

  @Get(":roleId/permissions")
  @RequirePermission("settings:rbac:manage")
  getPermissions(@Param("roleId") roleId: string, @CurrentUser() u: CurrentUserContext) {
    return this.roles.getRolePermissions(u.orgId, this.parseRoleId(roleId));
  }

  @Put(":roleId/permissions")
  @RequirePermission("settings:rbac:manage")
  setPermissions(
    @Param("roleId") roleId: string,
    @Body(new ZodValidationPipe(setRolePermissionsSchema)) body: SetRolePermissionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.setRolePermissions(u, this.parseRoleId(roleId), body);
  }

  @Get(":roleId/members")
  @RequirePermission("settings:rbac:manage")
  getMembers(@Param("roleId") roleId: string, @CurrentUser() u: CurrentUserContext) {
    return this.roles.getRoleMembers(u.orgId, this.parseRoleId(roleId));
  }

  @Post(":roleId/members")
  @RequirePermission("settings:rbac:manage")
  addMember(
    @Param("roleId") roleId: string,
    @Body(new ZodValidationPipe(roleMemberSchema)) body: RoleMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roles.addRoleMember(u, this.parseRoleId(roleId), body);
  }

  @Delete(":roleId/members")
  @RequirePermission("settings:rbac:manage")
  removeMember(
    @Param("roleId") roleId: string,
    @Body(new ZodValidationPipe(roleMemberSchema)) body: RoleMemberInput,
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
