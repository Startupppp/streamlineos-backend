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
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import {
  assertPermissionsGrantable,
  buildPermissionModuleMap,
  toGrantableSet,
} from "../../common/rbac/grantability";
import { AuditService } from "../../common/audit/audit.service";
import { AccessService } from "../access/access.service";
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

@Injectable()
export class UserPermissionGrantsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly moduleAccess: ModuleAccessService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
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
  ): Promise<{ id: number; userId: string }> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.id, membershipId),
      ),
      columns: { id: true, userId: true },
    });
    if (!member) throw new NotFoundException("Member not found");
    return { id: member.id, userId: member.userId };
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

    const target = await this.resolveTargetMembership(actor.orgId, membershipId);
    if (target.userId === actor.userId) {
      throw new ForbiddenException(
        "You cannot grant permissions to yourself",
      );
    }

    await this.assertGrantable(actor, Array.from(requested.keys()));

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

    return { success: true };
  }

  private async assertGrantable(
    actor: CurrentUserContext,
    keys: readonly string[],
  ): Promise<void> {
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
  }
}
