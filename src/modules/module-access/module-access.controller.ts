import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { ModuleAccessService } from "./module-access.service";
import { ModuleAccessGroupsService } from "./module-access-groups.service";
import { ModuleAccessRosterService } from "./module-access-roster.service";
import { ModuleAccessFlatMembersService } from "./module-access-flat-members.service";
import { ModuleAccessOwnershipService } from "./module-access-ownership.service";
import { ModuleStandingRosterService } from "./module-standing-roster.service";
import { ModuleStandingMutationsService } from "./module-standing-mutations.service";
import {
  addFlatMemberSchema,
  addModuleGroupMemberSchema,
  auditLogQuerySchema,
  createModuleGroupSchema,
  directTransferOwnerSchema,
  initiateOwnershipTransferSchema,
  listGroupsQuerySchema,
  listMembersQuerySchema,
  memberCandidatesQuerySchema,
  flatMemberParamSchema,
  moduleGroupMemberParamSchema,
  moduleGroupParamSchema,
  moduleKeyParamSchema,
  moduleRoleParamSchema,
  renameModuleGroupSchema,
  setModuleRolePermissionsSchema,
  standingMemberParamSchema,
  updateMemberGroupsSchema,
  type AddFlatMemberInput,
  type AddModuleGroupMemberInput,
  type AuditLogQuery,
  type CreateModuleGroupInput,
  type DirectTransferOwnerInput,
  type FlatMemberParam,
  type InitiateOwnershipTransferInput,
  type ListGroupsQuery,
  type ListMembersQuery,
  type MemberCandidatesQuery,
  type ModuleGroupMemberParam,
  type ModuleGroupParam,
  type ModuleKeyParam,
  type ModuleRoleParam,
  type RenameModuleGroupInput,
  type SetModuleRolePermissionsInput,
  type StandingMemberParam,
  type UpdateMemberGroupsInput,
} from "./dto/module-access.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  moduleStandingResponseSchema,
  moduleGrantableResponseSchema,
  moduleStandingMutationResponseSchema,
  moduleCatalogResponseSchema,
  moduleRolesResponseSchema,
  moduleSetPermissionsResponseSchema,
  moduleGroupListResponseSchema,
  moduleGroupResponseSchema,
  moduleGroupDeleteResponseSchema,
  moduleGroupMembersResponseSchema,
  moduleGroupMemberMutationResponseSchema,
  moduleCallerPermissionsResponseSchema,
  moduleRosterResponseSchema,
  moduleRosterMutationResponseSchema,
  moduleMemberCandidatesResponseSchema,
  moduleOwnershipResponseSchema,
  moduleOwnershipMutationResponseSchema,
  moduleAuditLogResponseSchema,
} from "./dto/module-access-response.schemas";

@Controller("module-access")
@UseGuards(JwtAuthGuard)
@AuthorizedInService("assertModuleAccessPolicy")
export class ModuleAccessController {
  constructor(
    private readonly svc: ModuleAccessService,
    private readonly groups: ModuleAccessGroupsService,
    private readonly roster: ModuleAccessRosterService,
    private readonly flatMembers: ModuleAccessFlatMembersService,
    private readonly ownership: ModuleAccessOwnershipService,
    private readonly standing: ModuleStandingRosterService,
    private readonly mutations: ModuleStandingMutationsService,
  ) {}

  @Get(":moduleKey/standing")
  @ResponseSchema(moduleStandingResponseSchema)
  @Validate({ params: moduleKeyParamSchema })
  listStanding(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.standing.listStanding(u, params.moduleKey);
  }

  @Get(":moduleKey/standing/grantable")
  @ResponseSchema(moduleGrantableResponseSchema)
  @Validate({ params: moduleKeyParamSchema })
  describeGrantable(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.standing.describeGrantable(u, params.moduleKey);
  }

  @Post(":moduleKey/standing/transfer-owner")
  @ResponseSchema(moduleStandingMutationResponseSchema)
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:ownership-transfer")
  @Validate({ params: moduleKeyParamSchema, body: directTransferOwnerSchema })
  directTransferOwnership(
    @Param() params: ModuleKeyParam,
    @Body() body: DirectTransferOwnerInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mutations.directTransferOwnership(u, params.moduleKey, body.toMembershipId);
  }

  @Post(":moduleKey/standing/:membershipId")
  @BodylessAction()
  @ResponseSchema(moduleStandingMutationResponseSchema)
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: standingMemberParamSchema })
  grantAdminStanding(
    @Param() params: StandingMemberParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mutations.grantAdminStanding(u, params.moduleKey, params.membershipId);
  }

  @Delete(":moduleKey/standing/:membershipId")
  @ResponseSchema(moduleStandingMutationResponseSchema)
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: standingMemberParamSchema })
  revokeStanding(
    @Param() params: StandingMemberParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mutations.revokeStanding(u, params.moduleKey, params.membershipId);
  }

  @Get(":moduleKey/catalog")
  @ResponseSchema(moduleCatalogResponseSchema)
  @Validate({ params: moduleKeyParamSchema })
  catalog(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listCatalog(u, params.moduleKey);
  }

  @Get(":moduleKey/roles")
  @ResponseSchema(moduleRolesResponseSchema)
  @Validate({ params: moduleKeyParamSchema })
  roles(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listRoles(u, params.moduleKey);
  }

  @Put(":moduleKey/roles/:roleId/permissions")
  @ResponseSchema(moduleSetPermissionsResponseSchema)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleRoleParamSchema, body: setModuleRolePermissionsSchema })
  setRolePermissions(
    @Param() params: ModuleRoleParam,
    @Body() body: SetModuleRolePermissionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setRolePermissions(u, params.moduleKey, params.roleId, body);
  }

  @Get(":moduleKey/groups")
  @ResponseSchema(moduleGroupListResponseSchema)
  @Validate({ params: moduleKeyParamSchema, query: listGroupsQuerySchema })
  listGroups(
    @Param() params: ModuleKeyParam,
    @Query() query: ListGroupsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.listGroups(u, params.moduleKey, query);
  }

  @Post(":moduleKey/groups")
  @ResponseSchema(moduleGroupResponseSchema)
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Idempotent("module-access.group.create")
  @Validate({ params: moduleKeyParamSchema, body: createModuleGroupSchema })
  createGroup(
    @Param() params: ModuleKeyParam,
    @Body() body: CreateModuleGroupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.createGroup(u, params.moduleKey, body);
  }

  @Patch(":moduleKey/groups/:groupId")
  @ResponseSchema(moduleGroupResponseSchema)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleGroupParamSchema, body: renameModuleGroupSchema })
  renameGroup(
    @Param() params: ModuleGroupParam,
    @Body() body: RenameModuleGroupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.renameGroup(u, params.moduleKey, params.groupId, body);
  }

  @Delete(":moduleKey/groups/:groupId")
  @ResponseSchema(moduleGroupDeleteResponseSchema)
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleGroupParamSchema })
  deleteGroup(
    @Param() params: ModuleGroupParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.deleteGroup(u, params.moduleKey, params.groupId);
  }

  @Put(":moduleKey/groups/:groupId/permissions")
  @ResponseSchema(moduleSetPermissionsResponseSchema)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleGroupParamSchema, body: setModuleRolePermissionsSchema })
  setGroupPermissions(
    @Param() params: ModuleGroupParam,
    @Body() body: SetModuleRolePermissionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setRolePermissions(u, params.moduleKey, params.groupId, body);
  }

  @Get(":moduleKey/groups/:groupId/members")
  @ResponseSchema(moduleGroupMembersResponseSchema)
  @Validate({ params: moduleGroupParamSchema })
  listGroupMembers(
    @Param() params: ModuleGroupParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.listGroupMembers(u, params.moduleKey, params.groupId);
  }

  @Post(":moduleKey/groups/:groupId/members")
  @ResponseSchema(moduleGroupMemberMutationResponseSchema)
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleGroupParamSchema, body: addModuleGroupMemberSchema })
  addGroupMember(
    @Param() params: ModuleGroupParam,
    @Body() body: AddModuleGroupMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.addGroupMember(u, params.moduleKey, params.groupId, body);
  }

  @Delete(":moduleKey/groups/:groupId/members/:userId")
  @ResponseSchema(moduleGroupMemberMutationResponseSchema)
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleGroupMemberParamSchema })
  removeGroupMember(
    @Param() params: ModuleGroupMemberParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.removeGroupMember(u, params.moduleKey, params.groupId, params.userId);
  }

  @Get(":moduleKey/me/permissions")
  @ResponseSchema(moduleCallerPermissionsResponseSchema)
  @Validate({ params: moduleKeyParamSchema })
  getCallerPermissions(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getCallerPermissions(u, params.moduleKey);
  }

  @Get(":moduleKey/members")
  @ResponseSchema(moduleRosterResponseSchema)
  @Validate({ params: moduleKeyParamSchema, query: listMembersQuerySchema })
  listMembers(
    @Param() params: ModuleKeyParam,
    @Query() query: ListMembersQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roster.listMembers(u, params.moduleKey, query);
  }

  @Post(":moduleKey/members")
  @ResponseSchema(moduleRosterMutationResponseSchema)
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleKeyParamSchema, body: addFlatMemberSchema })
  addMember(
    @Param() params: ModuleKeyParam,
    @Body() body: AddFlatMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flatMembers.addMember(u, params.moduleKey, body);
  }

  @Patch(":moduleKey/members/:userId")
  @ResponseSchema(moduleRosterMutationResponseSchema)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: flatMemberParamSchema, body: updateMemberGroupsSchema })
  updateMemberGroups(
    @Param() params: FlatMemberParam,
    @Body() body: UpdateMemberGroupsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flatMembers.updateMemberGroups(u, params.moduleKey, params.userId, body);
  }

  @Delete(":moduleKey/members/:userId")
  @ResponseSchema(moduleRosterMutationResponseSchema)
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: flatMemberParamSchema })
  removeMember(
    @Param() params: FlatMemberParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flatMembers.removeMember(u, params.moduleKey, params.userId);
  }

  @Get(":moduleKey/audit-log")
  @ResponseSchema(moduleAuditLogResponseSchema)
  @Validate({ params: moduleKeyParamSchema, query: auditLogQuerySchema })
  getAuditLog(
    @Param() params: ModuleKeyParam,
    @Query() query: AuditLogQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getAuditLog(u, params.moduleKey, query);
  }

  @Get(":moduleKey/member-candidates")
  @ResponseSchema(moduleMemberCandidatesResponseSchema)
  @Validate({ params: moduleKeyParamSchema, query: memberCandidatesQuerySchema })
  listMemberCandidates(
    @Param() params: ModuleKeyParam,
    @Query() query: MemberCandidatesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roster.listMemberCandidates(u, params.moduleKey, query);
  }

  @Get(":moduleKey/ownership")
  @ResponseSchema(moduleOwnershipResponseSchema)
  @Validate({ params: moduleKeyParamSchema })
  getOwnership(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ownership.getOwnership(u, params.moduleKey);
  }

  @Post(":moduleKey/ownership/transfer")
  @ResponseSchema(moduleOwnershipMutationResponseSchema)
  @Idempotent("ownership.module-access.transfer-initiate")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:ownership-transfer")
  @Validate({ params: moduleKeyParamSchema, body: initiateOwnershipTransferSchema })
  initiateOwnershipTransfer(
    @Param() params: ModuleKeyParam,
    @Body() body: InitiateOwnershipTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ownership.initiateTransfer(u, params.moduleKey, body.toUserId);
  }

  @Delete(":moduleKey/ownership/transfer")
  @ResponseSchema(moduleOwnershipMutationResponseSchema)
  @Idempotent("ownership.module-access.transfer-cancel")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:ownership-transfer")
  @Validate({ params: moduleKeyParamSchema })
  cancelOwnershipTransfer(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ownership.cancelTransfer(u, params.moduleKey);
  }
}
