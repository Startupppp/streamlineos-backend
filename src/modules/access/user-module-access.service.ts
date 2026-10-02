import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CacheService } from "../../common/cache/cache.service";
import {
  ADMINISTRABLE_MODULES,
} from "../../common/rbac/module-vocabulary";
import { commitAccessChange } from "../../common/rbac/access-mutation-commit";
import { ORG_MEMBER_ROLES } from "../../common/rbac/org-roles";
import { EntitlementsService } from "./entitlements.service";
import { MANAGEABLE_MODULE_SET } from "./access-policy";
import { AccessVersionCache } from "./access-version-cache";
import { DeniedModulesResolver } from "./denied-modules.resolver";
import type { ReadAccessTable } from "./access-permission.resolver";
import { writeUserModuleAccessOverride } from "./user-module-access.writer";

@Injectable()
export class UserModuleAccessService {
  private readonly deniedModulesResolver: DeniedModulesResolver;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
    private readonly cache: CacheService,
    private readonly accessVersionCache: AccessVersionCache,
  ) {
    const readAccessTable: ReadAccessTable = <Result>(
      read: () => PromiseLike<Result>,
    ): Promise<Result> => Promise.resolve(read());
    this.deniedModulesResolver = new DeniedModulesResolver(
      () => this.db,
      readAccessTable,
      (orgId) => this.accessVersionCache.getVersion(orgId),
      (moduleKey) => this.entitlements.isCoreModule(moduleKey),
    );
  }

  /**
   * No error fallback: an unreadable denial list must not resolve to "nothing
   * is denied". That empty set fails OPEN — it restores every module the org
   * took away from this user — and `DeniedModulesResolver.resolve` throws
   * rather than swallowing, same invariant as `AccessService.readAccessTable`.
   */
  async getUserDeniedModules(orgId: string, userId: string): Promise<Set<string>> {
    return this.deniedModulesResolver.resolve(orgId, userId);
  }

  async getUserModuleAccess(
    orgId: string,
    userId: string,
  ): Promise<{ moduleKey: string; enabled: boolean; core: boolean }[]> {
    const member = await runInTenantTransaction(
      this.db,
      () =>
        this.db.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, userId),
          ),
          columns: { id: true },
        }),
      { orgId },
    );
    if (!member)
      throw new NotFoundException("User is not a member of this organization");

    const denied = await this.getUserDeniedModules(orgId, userId);
    return ADMINISTRABLE_MODULES.map((moduleKey) => ({
      moduleKey,
      enabled: !denied.has(moduleKey),
      core: this.entitlements.isCoreModule(moduleKey),
    }));
  }

  async setUserModuleAccess(
    orgId: string,
    userId: string,
    moduleKey: string,
    enabled: boolean,
    updatedBy: string,
  ): Promise<{ moduleKey: string; enabled: boolean; core: boolean }[]> {
    if (!MANAGEABLE_MODULE_SET.has(moduleKey))
      throw new BadRequestException(`Unknown module "${moduleKey}"`);

    const isCoreModule = this.entitlements.isCoreModule(moduleKey);

    if (isCoreModule) {
      const member = await runInTenantTransaction(
        this.db,
        () =>
          this.db.query.organizationMembers.findFirst({
            where: and(
              eq(organizationMembers.orgId, orgId),
              eq(organizationMembers.userId, userId),
            ),
            columns: { userId: true, status: true },
          }),
        { orgId },
      );
      if (!member)
        throw new NotFoundException("User is not a member of this organization");
      if (member.status !== "ACTIVE")
        throw new BadRequestException(
          "Module access can only be changed for active members",
        );
      if (!enabled)
        throw new BadRequestException(
          `Module "${moduleKey}" is always available to organization members`,
        );
      return this.getUserModuleAccess(orgId, userId);
    }

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const member = await tx.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, userId),
          ),
          columns: { id: true, userId: true, status: true, role: true, isOwner: true },
        });
        if (!member)
          throw new NotFoundException(
            "User is not a member of this organization",
          );
        if (member.status !== "ACTIVE")
          throw new BadRequestException(
            "Module access can only be changed for active members",
          );
        if (!enabled && (member.isOwner || member.role === ORG_MEMBER_ROLES.ORG_ADMIN))
          throw new BadRequestException(
            "Organization Owner and Admin access cannot be disabled per member",
          );
        await writeUserModuleAccessOverride(
          tx,
          orgId,
          member.id,
          moduleKey,
          enabled,
          updatedBy,
        );
        await commitAccessChange(tx, orgId, {
          audit: {
            action: enabled ? "module_access.user_enabled" : "module_access.user_disabled",
            userId: updatedBy,
            targetId: userId,
            targetType: "user",
            resourceType: "module",
            resourceId: moduleKey,
            metadata: { moduleKey, enabled, membershipId: member.id },
          },
          revoke: { cache: this.cache, loses: [{ kind: "permissions", userIds: [userId] }] },
        });
      },
      { orgId },
    );
    return this.getUserModuleAccess(orgId, userId);
  }
}
