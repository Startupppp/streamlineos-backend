import type { DataScope } from "../../modules/access/access.types";
import { assertInvitableRole } from "./assert-invitable-role";
import { ORG_ADMIN_PERMISSION_KEY } from "./grantability";

/** Structural shape of AccessService, so this shared helper needs no runtime module import. */
export interface PermissionResolver {
  resolveUserPermissions(orgId: string, userId: string): Promise<Map<string, DataScope>>;
}

/** Resolves the actor's org-admin standing, then guards the structural role being granted. */
export async function assertMayGrantRole(
  access: PermissionResolver,
  orgId: string,
  actor: { userId: string; isOrgOwner: boolean },
  role: string,
): Promise<void> {
  let isOrgAdmin = false;
  if (!actor.isOrgOwner) {
    const resolved = await access.resolveUserPermissions(orgId, actor.userId);
    isOrgAdmin = (resolved.get(ORG_ADMIN_PERMISSION_KEY) ?? "none") !== "none";
  }
  assertInvitableRole({ isOrgOwner: actor.isOrgOwner, isOrgAdmin }, role);
}
