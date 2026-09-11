import { and, eq, sql } from "drizzle-orm";
import { roles } from "../../db/schema";
import type { DbOrTx } from "../../common/rbac/access-invalidate";

/**
 * Advances `roles.version`, the optimistic-concurrency token a bulk permission
 * write compares against — and, since `RoleGrantReconcilerService` landed, the
 * watermark that says an administrator has written this role's permissions.
 *
 * The single-key grant paths mutated the grants without advancing it, which cost
 * two things: a concurrent bulk `PUT` holding a stale version still succeeded and
 * clobbered the change, and the reconciler could not tell a hand-narrowed role
 * from a pristine one. Both are the same missing write.
 */
export async function markRoleAdministered(
  tx: DbOrTx,
  orgId: string,
  roleId: number,
): Promise<void> {
  await tx
    .update(roles)
    .set({ version: sql`${roles.version} + 1`, updatedAt: new Date() })
    .where(and(eq(roles.orgId, orgId), eq(roles.id, roleId)));
}
