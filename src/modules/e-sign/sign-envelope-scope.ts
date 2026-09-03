import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { actingMembershipId } from "../../common/auth/principal";
import { AccessService } from "../access/access.service";

/**
 * `sign:certificate:download` is not scopable, so its own grant can only ever say
 * "all". Envelope visibility is decided by `sign:envelope:view`, which is — and a
 * per-person `user_permission_grants` row may hand someone the download key while
 * their view key stays `own`. Binding the download routes to the scope resolved
 * here is what stops that grant from reading every executed contract in the org.
 */
export const SIGN_ENVELOPE_VIEW_PERMISSION = "sign:envelope:view";

export interface EnvelopeViewScope {
  membershipId: number | null;
  viewAll: boolean;
}

export function envelopeIsVisible(
  senderMembershipId: number | null,
  scope: EnvelopeViewScope,
): boolean {
  if (scope.viewAll) return true;
  return scope.membershipId != null && senderMembershipId === scope.membershipId;
}

export async function resolveEnvelopeViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<EnvelopeViewScope> {
  const scope = await access.scopeFor(u, SIGN_ENVELOPE_VIEW_PERMISSION);
  return { membershipId: actingMembershipId(u.principal), viewAll: scope === "all" };
}
