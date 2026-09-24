import type { CurrentUserContext } from "../../../common/auth/backend-claims";

export interface ShareTokenBearer {
  createdById: string | null;
  createdByMembershipId: number | null;
  publicToken: string | null;
}

export function withoutUnsharedToken<T extends ShareTokenBearer>(
  user: CurrentUserContext,
  page: T,
  membershipId: number | null,
  canManage: boolean,
): T {
  const canShare =
    user.isOrgOwner ||
    canManage ||
    (membershipId !== null && page.createdByMembershipId === membershipId) ||
    (page.createdByMembershipId === null && page.createdById === user.userId);
  return canShare ? page : { ...page, publicToken: null };
}
