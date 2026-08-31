import { Injectable } from "@nestjs/common";
import {
  assertManagedModule,
  assertModuleAccessPolicy,
  moduleAccessPolicyDeps,
} from "./module-access.helpers";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { Inject } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type {
  AddModuleGroupMemberInput,
  CreateModuleGroupInput,
  RenameModuleGroupInput,
} from "./dto/module-access.schemas";
import { ModuleAccessGroupPolicyService } from "./module-access-group-policy.service";
import {
  ModuleAccessGroupMembersService,
  type ModuleGroupMember,
} from "./module-access-group-members.service";
import { ModuleAccessGroupCrudService } from "./module-access-group-crud.service";
import type { ModuleRoleGroup } from "./module-access-groups.types";

export type { ModuleGroupMember } from "./module-access-group-members.service";
export type {
  FlatModuleMember,
  ModuleMemberCandidate,
  ModuleRoleGroup,
} from "./module-access-groups.types";

@Injectable()
export class ModuleAccessGroupsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly groupPolicy: ModuleAccessGroupPolicyService,
    private readonly groupCrud: ModuleAccessGroupCrudService,
    private readonly groupMembers: ModuleAccessGroupMembersService,
  ) {}

  private async assertAccess(
    actor: CurrentUserContext,
    moduleKey: string,
    action: "view" | "manage",
  ): Promise<void> {
    assertManagedModule(moduleKey);
    await assertModuleAccessPolicy(
      moduleAccessPolicyDeps(this.db, this.access),
      actor,
      moduleKey,
      action,
    );
  }

  private async assertGroupBelongsToModule(
    orgId: string,
    moduleKey: string,
    groupId: number,
  ): Promise<void> {
    await this.groupPolicy.assertGroupBelongsToModule(orgId, moduleKey, groupId);
  }

  async listGroups(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<ModuleRoleGroup[]> {
    await this.assertAccess(actor, moduleKey, "view");
    return this.groupCrud.listGroups(
      actor.orgId,
      moduleKey,
      await this.access.getPermissionsVersion(actor.orgId),
    );
  }

  async createGroup(
    actor: CurrentUserContext,
    moduleKey: string,
    input: CreateModuleGroupInput,
  ): Promise<ModuleRoleGroup> {
    await this.assertAccess(actor, moduleKey, "manage");
    return this.groupCrud.createGroup(actor, moduleKey, input);
  }

  async renameGroup(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
    input: RenameModuleGroupInput,
  ): Promise<ModuleRoleGroup> {
    await this.assertAccess(actor, moduleKey, "manage");
    return this.groupCrud.renameGroup(actor, moduleKey, groupId, input);
  }

  async deleteGroup(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");
    return this.groupCrud.deleteGroup(actor, moduleKey, groupId);
  }

  async listGroupMembers(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
  ): Promise<ModuleGroupMember[]> {
    await this.assertAccess(actor, moduleKey, "view");
    await this.assertGroupBelongsToModule(actor.orgId, moduleKey, groupId);
    const version = await this.access.getPermissionsVersion(actor.orgId);
    return this.cache.cached(
      CACHE_KEYS.moduleGroupMembers(actor.orgId, moduleKey, groupId, version),
      () => this.groupMembers.fetchGroupMembers(actor.orgId, groupId),
      CACHE_TTL.VERY_LONG,
    );
  }

  async addGroupMember(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
    input: AddModuleGroupMemberInput,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");
    await this.assertGroupBelongsToModule(actor.orgId, moduleKey, groupId);
    return this.groupMembers.addGroupMember(actor, moduleKey, groupId, input);
  }

  async removeGroupMember(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
    userId: string,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");
    await this.assertGroupBelongsToModule(actor.orgId, moduleKey, groupId);
    return this.groupMembers.removeGroupMember(actor, moduleKey, groupId, userId);
  }
}
