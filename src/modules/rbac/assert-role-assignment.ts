import { ForbiddenException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { rolePermissionGrants } from "../../db/schema";
import {
  assertPermissionsGrantable,
  buildPermissionAdministeringModuleMap,
  ROLE_RANK,
  toGrantableSet,
} from "../../common/rbac/grantability";
import { resolveActorRankContext } from "../../common/rbac/resolve-actor-rank";
import type { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

/**
 * An authorization decision may never be taken on a sample. The read below is
 * ordered so two identical calls see identical rows, and bounded one row above
 * the ceiling so an over-large role is refused outright rather than authorised
 * from whatever slice the planner happened to return.
 */
const MAX_EVALUABLE_ROLE_GRANTS = 5000;

export async function assertMayAssignRole(
  db: Db,
  access: AccessService,
  actor: CurrentUserContext,
  role: { id: number; rank: number; moduleKey: string | null },
): Promise<void> {
  if (role.rank === ROLE_RANK.MODULE_OWNER)
    throw new ForbiddenException(
      "Module owner roles must be assigned through the ownership service, not the generic role-assignment path",
    );

  if (actor.isOrgOwner) return;

  const grants = await db
    .select({ permissionKey: rolePermissionGrants.permissionKey })
    .from(rolePermissionGrants)
    .where(
      and(
        eq(rolePermissionGrants.orgId, actor.orgId),
        eq(rolePermissionGrants.roleId, role.id),
      ),
    )
    .orderBy(asc(rolePermissionGrants.permissionKey))
    .limit(MAX_EVALUABLE_ROLE_GRANTS + 1);
  if (grants.length > MAX_EVALUABLE_ROLE_GRANTS)
    throw new ForbiddenException(
      `This role holds more than ${MAX_EVALUABLE_ROLE_GRANTS} permission grants, so its assignment cannot be authorized; reduce its grants first`,
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
    buildPermissionAdministeringModuleMap(requestedKeys),
  );
}
