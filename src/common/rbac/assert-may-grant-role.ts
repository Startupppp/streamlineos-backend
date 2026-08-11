import type { Db } from "../../db/drizzle.types";
import { assertInvitableRole } from "./assert-invitable-role";
import { isStructuralOrgAdmin } from "./is-structural-org-admin";

/**
 * Resolves the actor's org-admin standing STRUCTURALLY, then guards the
 * structural role being granted. Deriving admin standing from holding
 * `settings:manage` would let any custom role carrying that key promote others
 * to ORG_ADMIN — AC-04 (CLAUDE.md §21).
 */
export async function assertMayGrantRole(
  db: Db,
  orgId: string,
  actor: { userId: string; isOrgOwner: boolean },
  role: string,
): Promise<void> {
  const isOrgAdmin = await isStructuralOrgAdmin(db, {
    orgId,
    userId: actor.userId,
    isOrgOwner: actor.isOrgOwner,
  });
  assertInvitableRole({ isOrgOwner: actor.isOrgOwner, isOrgAdmin }, role);
}
