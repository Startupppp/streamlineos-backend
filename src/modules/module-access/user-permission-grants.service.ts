import {
  BadRequestException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { userPermissionGrants } from "../../db/schema";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { AuditService } from "../../common/audit/audit.service";
import { AccessService } from "../access/access.service";
import type { DataScope } from "../access/access.types";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ModuleAccessService } from "./module-access.service";
import { setGrants, type GrantWriteDeps } from "./lib/grant-writes";
import {
  moduleKeys,
  resolveActiveTargetMembership,
  resolveActorMembershipId,
  resolveTargetMembership,
  type TargetMembership,
} from "./user-permission-grants.helpers";
import type { SetUserPermissionGrantsInput } from "./dto/user-permission-grants.schemas";

export type { TargetMembership };

export interface UserPermissionGrant {
  permissionKey: string;
  scope: DataScope;
  reason: string | null;
  createdAt: Date;
}

@Injectable()
export class UserPermissionGrantsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly moduleAccess: ModuleAccessService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async listGrants(
    actor: CurrentUserContext,
    moduleKey: string,
    membershipId: number,
  ): Promise<{ grants: UserPermissionGrant[] }> {
    await this.moduleAccess.assertModuleAccess(actor, moduleKey, "view");
    await resolveTargetMembership(this.db, actor.orgId, membershipId);

    const rows = await this.db
      .select({
        permissionKey: userPermissionGrants.permissionKey,
        scope: userPermissionGrants.scope,
        reason: userPermissionGrants.reason,
        createdAt: userPermissionGrants.createdAt,
      })
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.orgId, actor.orgId),
          eq(userPermissionGrants.organizationMembershipId, membershipId),
          eq(userPermissionGrants.moduleKey, moduleKey),
        ),
      );

    return { grants: rows };
  }

  /** @see lib/grant-writes.ts */
  async setGrants(
    actor: CurrentUserContext,
    moduleKey: string,
    membershipId: number,
    input: SetUserPermissionGrantsInput,
  ): Promise<{ success: true; granted: number }> {
    return setGrants(this.grantWriteDeps, actor, moduleKey, membershipId, input);
  }

  private get grantWriteDeps(): GrantWriteDeps {
    return {
      db: this.db,
      cache: this.cache,
      audit: this.audit,
      access: this.access,
      moduleAccess: this.moduleAccess,
      moduleKeys,
      resolveActiveTargetMembership: (orgId, membershipId) =>
        resolveActiveTargetMembership(this.db, orgId, membershipId),
      resolveActorMembershipId: (actor) => resolveActorMembershipId(this.db, actor),
    };
  }

  async removeGrant(
    actor: CurrentUserContext,
    moduleKey: string,
    membershipId: number,
    permissionKey: string,
  ): Promise<{ success: true }> {
    await this.moduleAccess.assertModuleAccess(actor, moduleKey, "manage");
    if (!moduleKeys(moduleKey).has(permissionKey)) {
      throw new BadRequestException(
        `Permission "${permissionKey}" is not part of the ${moduleKey} module`,
      );
    }
    const target = await resolveTargetMembership(this.db, actor.orgId, membershipId);

    await runInTenantTransaction(this.db, async (tx): Promise<void> => {
      await tx
        .delete(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, actor.orgId),
            eq(userPermissionGrants.organizationMembershipId, membershipId),
            eq(userPermissionGrants.moduleKey, moduleKey),
            inArray(userPermissionGrants.permissionKey, [permissionKey]),
          ),
        );
      await bumpPermissionsVersion(tx, actor.orgId);
    });

    this.audit.log({
      action: "access.user_permission_grant_removed",
      userId: actor.userId,
      orgId: actor.orgId,
      resourceType: "organization_member",
      resourceId: String(membershipId),
      metadata: { moduleKey, targetUserId: target.userId, permissionKey },
    });

    await this.cache.invalidate(CACHE_KEYS.userSession(target.userId));

    return { success: true };
  }

}
