import { eq, sql, type SQL } from "drizzle-orm";
import { kbArticles } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ScopedRead, OwnershipScope } from "../../access/scoped-read";
import { actingMembershipId } from "../../../common/auth/principal";

export function articleOwnerScope(membershipId: number | null): OwnershipScope {
  return { own: membershipId === null ? sql`false` : eq(kbArticles.ownerMembershipId, membershipId) };
}

/**
 * The one article-owner predicate `GET /kb/search` and every RAG retrieval share.
 * Returning it rather than applying it keeps the filter a plain indexed predicate
 * on `kb_articles (org_id, owner_membership_id)` that the caller pushes into the
 * candidate query, so a chunk is refused before it can reach a context window.
 */
export function articleOwnerScopeFilter(read: ScopedRead, user: CurrentUserContext): SQL {
  const membershipId = user.principal === undefined ? null : actingMembershipId(user.principal);
  return read.compose(
    { tenant: kbArticles.orgId, scope: articleOwnerScope(membershipId) },
    ({ sql: where }) => where,
    () => sql`false`,
  );
}
