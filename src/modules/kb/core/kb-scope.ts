import { eq } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { ScopedRead, type OwnershipScope } from "../../access/scoped-read";
import { kbSpaces } from "../../../db/schema";

export const KB_ARTICLES_VIEW_PERMISSION = "kb:articles:view";
export const KB_SPACES_VIEW_PERMISSION = "kb:spaces:view";

export async function resolveKbArticlesViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.for(access, u, KB_ARTICLES_VIEW_PERMISSION);
}

export async function resolveKbSpacesViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.for(access, u, KB_SPACES_VIEW_PERMISSION);
}

export function kbSpaceOwnerScope(membershipId: number): OwnershipScope {
  return { own: eq(kbSpaces.createdByMembershipId, membershipId) };
}
