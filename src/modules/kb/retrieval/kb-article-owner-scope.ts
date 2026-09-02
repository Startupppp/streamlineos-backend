import { eq, sql, type SQL } from "drizzle-orm";
import { kbArticles } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { actingMembershipId } from "../../../common/auth/principal";

/**
 * The one article-owner predicate `GET /kb/search` and every RAG retrieval share.
 * Returning it rather than applying it keeps the filter a plain indexed predicate
 * on `kb_articles (org_id, owner_membership_id)` that the caller pushes into the
 * candidate query, so a chunk is refused before it can reach a context window.
 */
export function articleOwnerScopeFilter(
  scope: DataScope,
  user: CurrentUserContext,
): SQL | null {
  if (scope === "all") return null;
  if (scope === "none") return sql`false`;
  const membershipId =
    user.principal === undefined ? null : actingMembershipId(user.principal);
  return membershipId === null ? sql`false` : eq(kbArticles.ownerMembershipId, membershipId);
}
