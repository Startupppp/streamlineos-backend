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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ModuleAccessService } from "./module-access.service";
import { ModuleAccessGroupsService } from "./module-access-groups.service";
import {
  addModuleGroupMemberSchema,
  createModuleGroupSchema,
  initiateOwnershipTransferSchema,
  moduleGroupMemberParamSchema,
  moduleGroupParamSchema,
  moduleKeyParamSchema,
  moduleRoleParamSchema,
  renameModuleGroupSchema,
  setModuleRolePermissionsSchema,
  type AddModuleGroupMemberInput,
  type CreateModuleGroupInput,
  type InitiateOwnershipTransferInput,
  type ModuleGroupMemberParam,
  type ModuleGroupParam,
  type ModuleKeyParam,
  type ModuleRoleParam,
  type RenameModuleGroupInput,
  type SetModuleRolePermissionsInput,
} from "./dto/module-access.schemas";

@Controller("module-access")
@UseGuards(JwtAuthGuard)
export class ModuleAccessController {
  constructor(
    private readonly svc: ModuleAccessService,
    private readonly groups: ModuleAccessGroupsService,
  ) {}

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
  createGroup(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @Body(new ZodValidationPipe(createModuleGroupSchema)) body: CreateModuleGroupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.createGroup(u, params.moduleKey, body);
  }

  @Patch(":moduleKey/groups/:groupId")
  renameGroup(
    @Param(new ZodValidationPipe(moduleGroupParamSchema)) params: ModuleGroupParam,
    @Body(new ZodValidationPipe(renameModuleGroupSchema)) body: RenameModuleGroupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.renameGroup(u, params.moduleKey, params.groupId, body);
  }

  @Delete(":moduleKey/groups/:groupId")
  @HttpCode(HttpStatus.OK)
  deleteGroup(
    @Param(new ZodValidationPipe(moduleGroupParamSchema)) params: ModuleGroupParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.deleteGroup(u, params.moduleKey, params.groupId);
  }

  @Put(":moduleKey/groups/:groupId/permissions")
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
  addGroupMember(
    @Param(new ZodValidationPipe(moduleGroupParamSchema)) params: ModuleGroupParam,
    @Body(new ZodValidationPipe(addModuleGroupMemberSchema)) body: AddModuleGroupMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.addGroupMember(u, params.moduleKey, params.groupId, body);
  }

  @Delete(":moduleKey/groups/:groupId/members/:userId")
  @HttpCode(HttpStatus.OK)
  removeGroupMember(
    @Param(new ZodValidationPipe(moduleGroupMemberParamSchema)) params: ModuleGroupMemberParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.removeGroupMember(u, params.moduleKey, params.groupId, params.userId);
  }

  @Get(":moduleKey/member-candidates")
  listMemberCandidates(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.listMemberCandidates(u, params.moduleKey);
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
  initiateOwnershipTransfer(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @Body(new ZodValidationPipe(initiateOwnershipTransferSchema)) body: InitiateOwnershipTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.initiateOwnershipTransfer(u, params.moduleKey, body);
  }

  @Delete(":moduleKey/ownership/transfer")
  @HttpCode(HttpStatus.OK)
  cancelOwnershipTransfer(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.groups.cancelOwnershipTransfer(u, params.moduleKey);
  }
}
