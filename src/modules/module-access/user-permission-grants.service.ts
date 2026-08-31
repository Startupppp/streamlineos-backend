import {
  BadRequestException,
  ForbiddenException,
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
import {
  assertPermissionsGrantable,
  buildPermissionModuleMap,
  toGrantableSet,
} from "../../common/rbac/grantability";
import { AuditService } from "../../common/audit/audit.service";
import { AccessService, SCOPE_RANK } from "../access/access.service";
import { moduleScopedPermissions } from "../rbac/permissions";
import type { DataScope } from "../access/access.types";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ModuleAccessService } from "./module-access.service";
import { resolveActorRankContext } from "./module-access.helpers";
import type { SetUserPermissionGrantsInput } from "./dto/user-permission-grants.schemas";

export interface UserPermissionGrant {
  permissionKey: string;
  scope: DataScope;
  reason: string | null;
  createdAt: Date;
}

interface TargetMembership {
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

  /**
   * Replaces this person's grants for one module. Grants in other modules are
   * untouched, so a module admin can never widen or narrow anything outside
   * their own module even by omission.
   */
  async setGrants(
    actor: CurrentUserContext,
    moduleKey: string,
    membershipId: number,
    input: SetUserPermissionGrantsInput,
  ): Promise<{ success: true; granted: number }> {
    await this.moduleAccess.assertModuleAccess(actor, moduleKey, "manage");

    const catalog = this.moduleKeys(moduleKey);
    const requested = new Map<string, DataScope>();
    for (const item of input.items) {
      if (!catalog.has(item.permissionKey)) {
        throw new BadRequestException(
          `Permission "${item.permissionKey}" is not part of the ${moduleKey} module`,
        );
      }
      requested.set(item.permissionKey, item.scope);
    }

    const target = await this.resolveActiveTargetMembership(
      actor.orgId,
      membershipId,
    );
    if (target.userId === actor.userId) {
      throw new ForbiddenException(
        "You cannot grant permissions to yourself",
      );
    }

    await this.assertGrantable(actor, requested);

    const grantedBy = await this.resolveActorMembershipId(actor);
    const rows = Array.from(requested.entries()).map(([permissionKey, scope]) => ({
      orgId: actor.orgId,
      organizationMembershipId: membershipId,
      permissionKey,
      scope,
      moduleKey,
      grantedByMembershipId: grantedBy,
      reason: input.reason ?? null,
    }));

    await runInTenantTransaction(this.db, async (tx): Promise<void> => {
      await tx
        .delete(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, actor.orgId),
            eq(userPermissionGrants.organizationMembershipId, membershipId),
            eq(userPermissionGrants.moduleKey, moduleKey),
          ),
        );
      if (rows.length > 0) await tx.insert(userPermissionGrants).values(rows);
      await bumpPermissionsVersion(tx, actor.orgId);
    });

    this.audit.log({
      action: "access.user_permission_grants_set",
      userId: actor.userId,
      orgId: actor.orgId,
      resourceType: "organization_member",
      resourceId: String(membershipId),
      metadata: {
        moduleKey,
        targetUserId: target.userId,
        permissionKeys: Array.from(requested.keys()),
      },
    });

    await this.cache.invalidate(CACHE_KEYS.userSession(target.userId));

    return { success: true, granted: rows.length };
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

  /**
   * A key may only be handed over at a scope the grantor themselves holds. The
   * request body carries the scope and defaults it to `all`, so without this
   * ceiling an `own` or `team` grantor mints org-wide access.
   */
  private async assertGrantable(
    actor: CurrentUserContext,
    requested: ReadonlyMap<string, DataScope>,
  ): Promise<void> {
    const keys = Array.from(requested.keys());
    if (keys.length === 0) return;

    const [resolved, { bestRank, allowedModules }] = await Promise.all([
      this.access.resolveUserPermissions(actor.orgId, actor.userId),
      resolveActorRankContext(this.db, actor.orgId, actor.userId),
    ]);

    assertPermissionsGrantable(
      {
        isOrgOwner: actor.isOrgOwner,
        grantable: toGrantableSet(resolved),
        bestRank,
        allowedModules,
      },
      keys,
      undefined,
      buildPermissionModuleMap(keys),
    );

    if (actor.isOrgOwner) return;

    const widened = keys.filter((key) => {
      const held = resolved.get(key);
      const wanted = requested.get(key);
      if (held === undefined || wanted === undefined) return true;
      return SCOPE_RANK[wanted] > SCOPE_RANK[held];
    });
    if (widened.length > 0) {
      const preview = widened.slice(0, 5).join(", ");
      throw new ForbiddenException(
        `You cannot grant a wider data scope than your own: ${preview}${
          widened.length > 5 ? ` (+${widened.length - 5} more)` : ""
        }`,
      );
    }
  }
}
