import { eq, sql, type SQL } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ScopedRead, OwnershipScope } from "../../access/scoped-read";
import type { AccessService } from "../../access/access.service";
import { resolveKbArticlesViewScope } from "../core/kb-scope";
import { actingMembershipId } from "../../../common/auth/principal";

export function articleOwnerScope(membershipId: number | null): OwnershipScope {
  return { own: membershipId === null ? sql`false` : eq(kbPages.ownerMembershipId, membershipId) };
}

export async function resolveArticleOwnerFilter(
  scopes: AccessService,
  user: CurrentUserContext,
): Promise<SQL> {
  const read = await resolveKbArticlesViewScope(scopes, user);
  return articleOwnerScopeFilter(read, user);
}

export function articleOwnerScopeFilter(read: ScopedRead, user: CurrentUserContext): SQL {
  const membershipId = user.principal === undefined ? null : actingMembershipId(user.principal);
  return read.compose(
    { tenant: kbPages.orgId, scope: articleOwnerScope(membershipId) },
    ({ sql: where }) => where,
    () => sql`false`,
  );
}
