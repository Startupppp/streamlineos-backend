import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { organizationMembers, userPermissionGrants } from "../../db/schema";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { AuditService } from "../../common/audit/audit.service";
import { AccessService } from "../access/access.service";
import { moduleScopedPermissions } from "../rbac/permissions";
import type { DataScope } from "../access/access.types";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ModuleAccessService } from "./module-access.service";
import { setGrants, type GrantWriteDeps } from "./lib/grant-writes";
import type { SetUserPermissionGrantsInput } from "./dto/user-permission-grants.schemas";

export interface UserPermissionGrant {
  permissionKey: string;
  scope: DataScope;
  reason: string | null;
  createdAt: Date;
}

export interface TargetMembership {
  id: number;
  userId: string;
  status: (typeof organizationMembers.$inferSelect)["status"];
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

  private moduleKeys(moduleKey: string): Set<string> {
    return new Set(moduleScopedPermissions(moduleKey));
  }

  /**
   * Resolves the target inside the actor's own organisation. A membership from
   * another tenant simply is not found here, so a cross-tenant grant is
   * unrepresentable rather than merely refused.
   */
  private async resolveTargetMembership(
    orgId: string,
    membershipId: number,
  ): Promise<TargetMembership> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.id, membershipId),
      ),
      columns: { id: true, userId: true, status: true },
    });
    if (!member) throw new NotFoundException("Member not found");
    return { id: member.id, userId: member.userId, status: member.status };
  }

  /**
   * Widening capability needs a live membership, matching the module-access
   * path. Reading and revoking stay open on a suspended person on purpose, so
   * grants left behind can still be audited and cleared.
   */
  private async resolveActiveTargetMembership(
    orgId: string,
    membershipId: number,
  ): Promise<TargetMembership> {
    const member = await this.resolveTargetMembership(orgId, membershipId);
    if (member.status !== "ACTIVE") {
      throw new BadRequestException(
        "Permissions can only be granted to active members",
      );
    }
    return member;
  }

  private async resolveActorMembershipId(
    actor: CurrentUserContext,
  ): Promise<number | null> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.userId, actor.userId),
      ),
      columns: { id: true },
    });
    return member?.id ?? null;
  }

  async listGrants(
    actor: CurrentUserContext,
    moduleKey: string,
    membershipId: number,
  ): Promise<{ grants: UserPermissionGrant[] }> {
    await this.moduleAccess.assertModuleAccess(actor, moduleKey, "view");
    await this.resolveTargetMembership(actor.orgId, membershipId);

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
      moduleKeys: (moduleKey) => this.moduleKeys(moduleKey),
      resolveActiveTargetMembership: (orgId, membershipId) =>
        this.resolveActiveTargetMembership(orgId, membershipId),
      resolveActorMembershipId: (actor) => this.resolveActorMembershipId(actor),
    };
  }

  async removeGrant(
    actor: CurrentUserContext,
    moduleKey: string,
    membershipId: number,
    permissionKey: string,
  ): Promise<{ success: true }> {
    await this.moduleAccess.assertModuleAccess(actor, moduleKey, "manage");
    if (!this.moduleKeys(moduleKey).has(permissionKey)) {
      throw new BadRequestException(
        `Permission "${permissionKey}" is not part of the ${moduleKey} module`,
      );
    }
    const target = await this.resolveTargetMembership(actor.orgId, membershipId);

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
