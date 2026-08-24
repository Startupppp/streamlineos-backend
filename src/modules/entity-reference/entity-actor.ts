import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { EntityActor } from "./entity-reference.types";

export function actorOf(u: CurrentUserContext): EntityActor {
  return { orgId: u.orgId, userId: u.userId, isOrgOwner: u.isOrgOwner };
}
