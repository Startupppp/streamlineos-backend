import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { rolePermissionGrants } from "../../db/schema";
import {
  assertPermissionsGrantable,
  buildPermissionModuleMap,
  toGrantableSet,
} from "../../common/rbac/grantability";
import { resolveActorRankContext } from "../../common/rbac/resolve-actor-rank";
import type { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

export async function assertMayAssignRole(
  db: Db,
  access: AccessService,
  actor: CurrentUserContext,
  role: { id: number; rank: number; moduleKey: string | null },
): Promise<void> {
  if (actor.isOrgOwner) return;

  const grants = await db
    .select({ permissionKey: rolePermissionGrants.permissionKey })
    .from(rolePermissionGrants)
    .where(
      and(
        eq(rolePermissionGrants.orgId, actor.orgId),
        eq(rolePermissionGrants.roleId, role.id),
      ),
    );
  const requestedKeys = grants.map((g) => g.permissionKey);

  const [resolved, { bestRank, allowedModules }] = await Promise.all([
    access.resolveUserPermissions(actor.orgId, actor.userId),
    resolveActorRankContext(db, actor.orgId, actor.userId),
  ]);

  assertPermissionsGrantable(
    {
      isOrgOwner: false,
      grantable: toGrantableSet(resolved),
      bestRank,
      allowedModules,
    },
    requestedKeys,
    { rank: role.rank, moduleKey: role.moduleKey },
    buildPermissionModuleMap(requestedKeys),
  );
}
