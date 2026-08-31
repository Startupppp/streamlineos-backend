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
  renameModuleGroupSchema,
  setModuleRolePermissionsSchema,
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
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const moduleKeyParams = z.object({ moduleKey: z.string().min(1) }).strict();
const moduleKeymembershipIdParams = z.object({ moduleKey: z.string().min(1), membershipId: z.string().min(1) }).strict();
const moduleKeyroleIdParams = z.object({ moduleKey: z.string().min(1), roleId: z.string().min(1) }).strict();
const moduleKeygroupIdParams = z.object({ moduleKey: z.string().min(1), groupId: z.string().min(1) }).strict();
const moduleKeygroupIduserIdParams = z.object({ moduleKey: z.string().min(1), groupId: z.string().min(1), userId: z.string().min(1) }).strict();
const moduleKeyuserIdParams = z.object({ moduleKey: z.string().min(1), userId: z.string().min(1) }).strict();

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
  @Validate({ params: moduleKeyParams })
  listStanding(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.standing.listStanding(u, params.moduleKey);
  }

  @Get(":moduleKey/standing/grantable")
  @Validate({ params: moduleKeyParams })
  describeGrantable(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.standing.describeGrantable(u, params.moduleKey);
  }

  @Post(":moduleKey/standing/transfer-owner")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:ownership-transfer")
  @Validate({ params: moduleKeyParams, body: directTransferOwnerSchema })
  directTransferOwnership(
    @Param() params: ModuleKeyParam,
    @Body() body: DirectTransferOwnerInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mutations.directTransferOwnership(u, params.moduleKey, body.toMembershipId);
  }

  @Post(":moduleKey/standing/:membershipId")
  @BodylessAction()
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleKeymembershipIdParams })
  grantAdminStanding(
    @Param() params: StandingMemberParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mutations.grantAdminStanding(u, params.moduleKey, params.membershipId);
  }

  @Delete(":moduleKey/standing/:membershipId")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleKeymembershipIdParams })
  revokeStanding(
    @Param() params: StandingMemberParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mutations.revokeStanding(u, params.moduleKey, params.membershipId);
  }

  @Get(":moduleKey/catalog")
  @Validate({ params: moduleKeyParams })
  catalog(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listCatalog(u, params.moduleKey);
  }

  @Get(":moduleKey/roles")
  @Validate({ params: moduleKeyParams })
  roles(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listRoles(u, params.moduleKey);
  }

  @Put(":moduleKey/roles/:roleId/permissions")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleKeyroleIdParams, body: setModuleRolePermissionsSchema })
  setRolePermissions(
    @Param() params: ModuleRoleParam,
    @Body() body: SetModuleRolePermissionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setRolePermissions(u, params.moduleKey, params.roleId, body);
  }

  @Get(":moduleKey/groups")
  @Validate({ params: moduleKeyParams, query: listGroupsQuerySchema })
  listGroups(
    @Param() params: ModuleKeyParam,
    @Query() query: ListGroupsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.listGroups(u, params.moduleKey, query);
  }

  @Post(":moduleKey/groups")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleKeyParams, body: createModuleGroupSchema })
  createGroup(
    @Param() params: ModuleKeyParam,
    @Body() body: CreateModuleGroupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.createGroup(u, params.moduleKey, body);
  }

  @Patch(":moduleKey/groups/:groupId")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleKeygroupIdParams, body: renameModuleGroupSchema })
  renameGroup(
    @Param() params: ModuleGroupParam,
    @Body() body: RenameModuleGroupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.renameGroup(u, params.moduleKey, params.groupId, body);
  }

  @Delete(":moduleKey/groups/:groupId")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleKeygroupIdParams })
  deleteGroup(
    @Param() params: ModuleGroupParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.deleteGroup(u, params.moduleKey, params.groupId);
  }

  @Put(":moduleKey/groups/:groupId/permissions")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleKeygroupIdParams, body: setModuleRolePermissionsSchema })
  setGroupPermissions(
    @Param() params: ModuleGroupParam,
    @Body() body: SetModuleRolePermissionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setRolePermissions(u, params.moduleKey, params.groupId, body);
  }

  @Get(":moduleKey/groups/:groupId/members")
  @Validate({ params: moduleKeygroupIdParams })
  listGroupMembers(
    @Param() params: ModuleGroupParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.listGroupMembers(u, params.moduleKey, params.groupId);
  }

  @Post(":moduleKey/groups/:groupId/members")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleKeygroupIdParams, body: addModuleGroupMemberSchema })
  addGroupMember(
    @Param() params: ModuleGroupParam,
    @Body() body: AddModuleGroupMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.addGroupMember(u, params.moduleKey, params.groupId, body);
  }

  @Delete(":moduleKey/groups/:groupId/members/:userId")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleKeygroupIduserIdParams })
  removeGroupMember(
    @Param() params: ModuleGroupMemberParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.removeGroupMember(u, params.moduleKey, params.groupId, params.userId);
  }

  @Get(":moduleKey/me/permissions")
  @Validate({ params: moduleKeyParams })
  getCallerPermissions(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getCallerPermissions(u, params.moduleKey);
  }

  @Get(":moduleKey/members")
  @Validate({ params: moduleKeyParams, query: listMembersQuerySchema })
  listMembers(
    @Param() params: ModuleKeyParam,
    @Query() query: ListMembersQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roster.listMembers(u, params.moduleKey, query);
  }

  @Post(":moduleKey/members")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleKeyParams, body: addFlatMemberSchema })
  addMember(
    @Param() params: ModuleKeyParam,
    @Body() body: AddFlatMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flatMembers.addMember(u, params.moduleKey, body);
  }

  @Patch(":moduleKey/members/:userId")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleKeyuserIdParams, body: updateMemberGroupsSchema })
  updateMemberGroups(
    @Param() params: FlatMemberParam,
    @Body() body: UpdateMemberGroupsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flatMembers.updateMemberGroups(u, params.moduleKey, params.userId, body);
  }

  @Delete(":moduleKey/members/:userId")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  @Validate({ params: moduleKeyuserIdParams })
  removeMember(
    @Param() params: FlatMemberParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.flatMembers.removeMember(u, params.moduleKey, params.userId);
  }

  @Get(":moduleKey/audit-log")
  @Validate({ params: moduleKeyParams, query: auditLogQuerySchema })
  getAuditLog(
    @Param() params: ModuleKeyParam,
    @Query() query: AuditLogQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getAuditLog(u, params.moduleKey, query);
  }

  @Get(":moduleKey/member-candidates")
  @Validate({ params: moduleKeyParams, query: memberCandidatesQuerySchema })
  listMemberCandidates(
    @Param() params: ModuleKeyParam,
    @Query() query: MemberCandidatesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roster.listMemberCandidates(u, params.moduleKey, query);
  }

  @Get(":moduleKey/ownership")
  @Validate({ params: moduleKeyParams })
  getOwnership(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ownership.getOwnership(u, params.moduleKey);
  }

  @Post(":moduleKey/ownership/transfer")
  @Idempotent("ownership.module-access.transfer-initiate")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:ownership-transfer")
  @Validate({ params: moduleKeyParams, body: initiateOwnershipTransferSchema })
  initiateOwnershipTransfer(
    @Param() params: ModuleKeyParam,
    @Body() body: InitiateOwnershipTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ownership.initiateTransfer(u, params.moduleKey, body.toUserId);
  }

  @Delete(":moduleKey/ownership/transfer")
  @Idempotent("ownership.module-access.transfer-cancel")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:ownership-transfer")
  @Validate({ params: moduleKeyParams })
  cancelOwnershipTransfer(
    @Param() params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ownership.cancelTransfer(u, params.moduleKey);
  }
}
