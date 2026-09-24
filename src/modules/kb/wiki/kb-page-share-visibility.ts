import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { hashPublicToken, newPublicToken } from "./kb-public-token";

export interface PublicTokenColumns {
  publicToken?: string | null;
  publicTokenHash?: string | null;
  bumpRevision: boolean;
}

export function publicTokenColumnsFor(
  visibility: "private" | "org" | "public",
  existingToken: string | null,
): PublicTokenColumns {
  if (visibility !== "public")
    return { publicToken: null, publicTokenHash: null, bumpRevision: true };

  if (existingToken !== null) return { bumpRevision: false };
  const token = newPublicToken();
  return { publicToken: token, publicTokenHash: hashPublicToken(token), bumpRevision: true };
}

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
