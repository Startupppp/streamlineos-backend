import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { organizationMembers, userPermissionGrants } from "../../../db/schema";
import { CacheService } from "../../../common/cache/cache.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { commitAccessChange } from "../../../common/rbac/access-mutation-commit";
import {
  assertPermissionsGrantable,
  buildPermissionAdministeringModuleMap,
  toGrantableSet,
} from "../../../common/rbac/grantability";
import { AccessService, SCOPE_RANK } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleAccessService } from "../module-access.service";
import { resolveActorRankContext } from "../module-access.helpers";
import type { SetUserPermissionGrantsInput } from "../dto/user-permission-grants.schemas";

export interface TargetMembership {
  id: number;
  userId: string;
  status: (typeof organizationMembers.$inferSelect)["status"];
}

/**
 * Writing a user's permission grants, and refusing the ones the actor may not
 * give away.
 *
 * Split from the reads because this is the half with the escalation rule:
 * nobody may grant a permission they do not themselves hold, at a scope wider
 * than their own. `assertGrantable` is the only expression of that, and it is
 * exported nowhere — a caller wanting to write grants goes through `setGrants`,
 * which cannot skip it.
 *
 * The membership resolvers stay on the service and arrive as callbacks: they
 * are shared with the read path, and duplicating them is how the two halves
 * would come to disagree about what an ACTIVE membership is.
 */
export interface GrantWriteDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly access: AccessService;
  readonly moduleAccess: ModuleAccessService;
  readonly moduleKeys: (moduleKey: string) => Set<string>;
  readonly resolveActiveTargetMembership: (
    orgId: string,
    membershipId: number,
  ) => Promise<TargetMembership>;
  readonly resolveActorMembershipId: (actor: CurrentUserContext) => Promise<number | null>;
}

/**
 * Replaces this person's grants for one module. Grants in other modules are
 * untouched, so a module admin can never widen or narrow anything outside
 * their own module even by omission.
 */
export async function setGrants(
  deps: GrantWriteDeps,
  actor: CurrentUserContext,
  moduleKey: string,
  membershipId: number,
  input: SetUserPermissionGrantsInput,
): Promise<{ success: true; granted: number }> {
  await deps.moduleAccess.assertModuleAccess(actor, moduleKey, "manage");

  const catalog = deps.moduleKeys(moduleKey);
  const requested = new Map<string, DataScope>();
  for (const item of input.items) {
    if (!catalog.has(item.permissionKey)) {
      throw new BadRequestException(
        `Permission "${item.permissionKey}" is not part of the ${moduleKey} module`,
      );
    }
    requested.set(item.permissionKey, item.scope);
  }

  const target = await deps.resolveActiveTargetMembership(
    actor.orgId,
    membershipId,
  );
  if (target.userId === actor.userId) {
    throw new ForbiddenException(
      "You cannot grant permissions to yourself",
    );
  }

  await assertGrantable(deps, actor, requested);

  const grantedBy = await deps.resolveActorMembershipId(actor);
  const rows = Array.from(requested.entries()).map(([permissionKey, scope]) => ({
    orgId: actor.orgId,
    organizationMembershipId: membershipId,
    permissionKey,
    scope,
    moduleKey,
    grantedByMembershipId: grantedBy,
    reason: input.reason ?? null,
  }));

  await runInTenantTransaction(deps.db, async (tx): Promise<void> => {
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
    await commitAccessChange(tx, actor.orgId, {
      audit: {
        action: "access.user_permission_grants_set",
        userId: actor.userId,
        resourceType: "organization_member",
        resourceId: String(membershipId),
        metadata: {
          moduleKey,
          targetUserId: target.userId,
          permissionKeys: Array.from(requested.keys()),
        },
      },
      revoke: {
        cache: deps.cache,
        loses: [{ kind: "permissions", userIds: [target.userId] }],
      },
    });
  });

  return { success: true, granted: rows.length };
}

/**
 * A key may only be handed over at a scope the grantor themselves holds. The
 * request body carries the scope and defaults it to `all`, so without this
 * ceiling an `own` or `team` grantor mints org-wide access.
 */
async function assertGrantable(
  deps: GrantWriteDeps,
  actor: CurrentUserContext,
  requested: ReadonlyMap<string, DataScope>,
): Promise<void> {
  const keys = Array.from(requested.keys());
  if (keys.length === 0) return;

  const [resolved, { bestRank, allowedModules }] = await Promise.all([
    deps.access.resolveUserPermissions(actor.orgId, actor.userId),
    resolveActorRankContext(deps.db, actor.orgId, actor.userId),
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
    buildPermissionAdministeringModuleMap(keys),
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
