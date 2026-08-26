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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { ModuleAccessService } from "./module-access.service";
import { ModuleAccessGroupsService } from "./module-access-groups.service";
import { ModuleStandingRosterService } from "./module-standing-roster.service";
import {
  addFlatMemberSchema,
  addModuleGroupMemberSchema,
  auditLogQuerySchema,
  createModuleGroupSchema,
  flatMemberParamSchema,
  initiateOwnershipTransferSchema,
  listMembersQuerySchema,
  memberCandidatesQuerySchema,
  moduleGroupMemberParamSchema,
  moduleGroupParamSchema,
  moduleKeyParamSchema,
  moduleRoleParamSchema,
  renameModuleGroupSchema,
  setModuleRolePermissionsSchema,
  updateMemberGroupsSchema,
  type AddFlatMemberInput,
  type AddModuleGroupMemberInput,
  type AuditLogQuery,
  type CreateModuleGroupInput,
  type FlatMemberParam,
  type InitiateOwnershipTransferInput,
  type ListMembersQuery,
  type MemberCandidatesQuery,
  type ModuleGroupMemberParam,
  type ModuleGroupParam,
  type ModuleKeyParam,
  type ModuleRoleParam,
  type RenameModuleGroupInput,
  type SetModuleRolePermissionsInput,
  type UpdateMemberGroupsInput,
} from "./dto/module-access.schemas";

@Controller("module-access")
@UseGuards(JwtAuthGuard)
export class ModuleAccessController {
  constructor(
    private readonly svc: ModuleAccessService,
    private readonly groups: ModuleAccessGroupsService,
    private readonly standing: ModuleStandingRosterService,
  ) {}

  @Get(":moduleKey/standing")
  listStanding(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.standing.listStanding(u, params.moduleKey);
  }

  @Get(":moduleKey/standing/grantable")
  describeGrantable(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.standing.describeGrantable(u, params.moduleKey);
  }

  @Get(":moduleKey/catalog")
  catalog(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listCatalog(u, params.moduleKey);
  }

  @Get(":moduleKey/roles")
  roles(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listRoles(u, params.moduleKey);
  }

  @Put(":moduleKey/roles/:roleId/permissions")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  setRolePermissions(
    @Param(new ZodValidationPipe(moduleRoleParamSchema)) params: ModuleRoleParam,
    @Body(new ZodValidationPipe(setModuleRolePermissionsSchema)) body: SetModuleRolePermissionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setRolePermissions(u, params.moduleKey, params.roleId, body);
  }

  @Get(":moduleKey/groups")
  listGroups(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.listGroups(u, params.moduleKey);
  }

  @Post(":moduleKey/groups")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  createGroup(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @Body(new ZodValidationPipe(createModuleGroupSchema)) body: CreateModuleGroupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.createGroup(u, params.moduleKey, body);
  }

  @Patch(":moduleKey/groups/:groupId")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  renameGroup(
    @Param(new ZodValidationPipe(moduleGroupParamSchema)) params: ModuleGroupParam,
    @Body(new ZodValidationPipe(renameModuleGroupSchema)) body: RenameModuleGroupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.renameGroup(u, params.moduleKey, params.groupId, body);
  }

  @Delete(":moduleKey/groups/:groupId")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  deleteGroup(
    @Param(new ZodValidationPipe(moduleGroupParamSchema)) params: ModuleGroupParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.deleteGroup(u, params.moduleKey, params.groupId);
  }

  @Put(":moduleKey/groups/:groupId/permissions")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  setGroupPermissions(
    @Param(new ZodValidationPipe(moduleGroupParamSchema)) params: ModuleGroupParam,
    @Body(new ZodValidationPipe(setModuleRolePermissionsSchema)) body: SetModuleRolePermissionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setRolePermissions(u, params.moduleKey, params.groupId, body);
  }

  @Get(":moduleKey/groups/:groupId/members")
  listGroupMembers(
    @Param(new ZodValidationPipe(moduleGroupParamSchema)) params: ModuleGroupParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.listGroupMembers(u, params.moduleKey, params.groupId);
  }

  @Post(":moduleKey/groups/:groupId/members")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  addGroupMember(
    @Param(new ZodValidationPipe(moduleGroupParamSchema)) params: ModuleGroupParam,
    @Body(new ZodValidationPipe(addModuleGroupMemberSchema)) body: AddModuleGroupMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.addGroupMember(u, params.moduleKey, params.groupId, body);
  }

  @Delete(":moduleKey/groups/:groupId/members/:userId")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  removeGroupMember(
    @Param(new ZodValidationPipe(moduleGroupMemberParamSchema)) params: ModuleGroupMemberParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.removeGroupMember(u, params.moduleKey, params.groupId, params.userId);
  }

  @Get(":moduleKey/me/permissions")
  getCallerPermissions(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getCallerPermissions(u, params.moduleKey);
  }

  @Get(":moduleKey/members")
  listMembers(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @Query(new ZodValidationPipe(listMembersQuerySchema)) query: ListMembersQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.listMembers(u, params.moduleKey, query);
  }

  @Post(":moduleKey/members")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  addMember(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @Body(new ZodValidationPipe(addFlatMemberSchema)) body: AddFlatMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.addMember(u, params.moduleKey, body);
  }

  @Patch(":moduleKey/members/:userId")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  updateMemberGroups(
    @Param(new ZodValidationPipe(flatMemberParamSchema)) params: FlatMemberParam,
    @Body(new ZodValidationPipe(updateMemberGroupsSchema)) body: UpdateMemberGroupsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.updateMemberGroups(u, params.moduleKey, params.userId, body);
  }

  @Delete(":moduleKey/members/:userId")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:group-mutate")
  removeMember(
    @Param(new ZodValidationPipe(flatMemberParamSchema)) params: FlatMemberParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.removeMember(u, params.moduleKey, params.userId);
  }

  @Get(":moduleKey/audit-log")
  getAuditLog(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @Query(new ZodValidationPipe(auditLogQuerySchema)) query: AuditLogQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getAuditLog(u, params.moduleKey, query);
  }

  @Get(":moduleKey/member-candidates")
  listMemberCandidates(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @Query(new ZodValidationPipe(memberCandidatesQuerySchema)) query: MemberCandidatesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.listMemberCandidates(u, params.moduleKey, query);
  }

  @Get(":moduleKey/ownership")
  getOwnership(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.getOwnership(u, params.moduleKey);
  }

  @Post(":moduleKey/ownership/transfer")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:ownership-transfer")
  initiateOwnershipTransfer(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @Body(new ZodValidationPipe(initiateOwnershipTransferSchema)) body: InitiateOwnershipTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.initiateOwnershipTransfer(u, params.moduleKey, body);
  }

  @Delete(":moduleKey/ownership/transfer")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("module-access:ownership-transfer")
  cancelOwnershipTransfer(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.cancelOwnershipTransfer(u, params.moduleKey);
  }
}
