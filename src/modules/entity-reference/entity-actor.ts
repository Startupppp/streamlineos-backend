import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { EntityActor } from "./entity-reference.types";
import { actingMembershipId } from "../../common/auth/principal";

export function actorOf(u: CurrentUserContext): EntityActor {
  const membershipId = u.principal === undefined ? null : actingMembershipId(u.principal);
  return {
    orgId: u.orgId,
    userId: u.userId,
    ...(membershipId === null ? {} : { membershipId }),
    isOrgOwner: u.isOrgOwner,
  };
}
