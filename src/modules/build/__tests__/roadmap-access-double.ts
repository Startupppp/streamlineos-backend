import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { AccessService } from "../../access/access.service";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import { MANAGER_STANDING, standingAccess } from "./project-access-doubles";

export function orgWideRoadmapAccess(): AccessService {
  const standing = standingAccess(MANAGER_STANDING);
  return stubService<AccessService>({ scopeFor: standing.scopeFor, holds: standing.holds });
}

export function roadmapActor(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}
