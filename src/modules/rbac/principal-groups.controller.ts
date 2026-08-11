import {
  BadRequestException,
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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { PrincipalGroupsService } from "./principal-groups.service";
import {
  addGroupMemberSchema,
  assignGroupRoleSchema,
  createGroupSchema,
  listGroupsQuerySchema,
  renameGroupSchema,
  type AddGroupMemberInput,
  type AssignGroupRoleInput,
  type CreateGroupInput,
  type ListGroupsQuery,
  type RenameGroupInput,
} from "./dto/principal-groups.schemas";

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

@Controller("principal-groups")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("settings:rbac:manage")
export class PrincipalGroupsController {
  constructor(private readonly groups: PrincipalGroupsService) {}

  @Get()
  @Validate({ query: listGroupsQuerySchema })
  list(@Query() query: ListGroupsQuery, @CurrentUser() u: CurrentUserContext) {
    return this.groups.list(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @Validate({ body: createGroupSchema })
  create(@Body() body: CreateGroupInput, @CurrentUser() u: CurrentUserContext) {
    return this.groups.create(u, body);
  }

  @Patch(":groupId")
  @Validate({ body: renameGroupSchema })
  rename(
    @Param("groupId") groupId: string,
    @Body() body: RenameGroupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.rename(u, this.parseUuid(groupId), body);
  }

  @Get(":groupId/members")
  getMembers(
    @Param("groupId") groupId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.getMembers(u.orgId, this.parseUuid(groupId));
  }

  @Post(":groupId/members")
  @HttpCode(201)
  @Validate({ body: addGroupMemberSchema })
  addMember(
    @Param("groupId") groupId: string,
    @Body() body: AddGroupMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.addMember(u, this.parseUuid(groupId), body);
  }

  @Delete(":groupId/members/:membershipId")
  removeMember(
    @Param("groupId") groupId: string,
    @Param("membershipId") membershipId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.removeMember(
      u,
      this.parseUuid(groupId),
      this.parseIntParam(membershipId),
    );
  }

  @Get(":groupId/roles")
  getAssignedRoles(
    @Param("groupId") groupId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.getAssignedRoles(u.orgId, this.parseUuid(groupId));
  }

  @Post(":groupId/roles")
  @HttpCode(201)
  @Validate({ body: assignGroupRoleSchema })
  assignRole(
    @Param("groupId") groupId: string,
    @Body() body: AssignGroupRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.assignRole(u, this.parseUuid(groupId), body);
  }

  @Delete(":groupId/roles/:roleId")
  unassignRole(
    @Param("groupId") groupId: string,
    @Param("roleId") roleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.unassignRole(
      u,
      this.parseUuid(groupId),
      this.parseIntParam(roleId),
    );
  }

  private parseUuid(raw: string): string {
    if (!UUID_RE.test(raw)) throw new BadRequestException("Invalid ID format");
    return raw;
  }

  private parseIntParam(raw: string): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0)
      throw new BadRequestException("Invalid ID");
    return n;
  }
}
