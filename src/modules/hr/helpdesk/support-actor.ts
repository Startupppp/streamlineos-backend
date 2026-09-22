import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { AccessService } from "../../access/access.service";
import { SUPPORT_ADMIN_PERMISSION, memberQueues, type SupportActor } from "./lib/support-queues";

export async function resolveSupportActor(
  access: AccessService,
  u: CurrentUserContext,
): Promise<SupportActor> {
  const membershipId = actingMembershipId(u.principal);
  if (u.isOrgOwner)
    return { orgId: u.orgId, userId: u.userId, membershipId, isAdmin: true, queues: memberQueues(new Set(), true) };
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  const held = new Set<string>();
  for (const [key, scope] of resolved) if (scope !== "none") held.add(key);
  const isAdmin = held.has(SUPPORT_ADMIN_PERMISSION);
  return { orgId: u.orgId, userId: u.userId, membershipId, isAdmin, queues: memberQueues(held, isAdmin) };
}
