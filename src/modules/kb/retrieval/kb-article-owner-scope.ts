import { eq, sql, type SQL } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ScopedRead, OwnershipScope } from "../../access/scoped-read";
import { actingMembershipId } from "../../../common/auth/principal";

export function articleOwnerScope(membershipId: number | null): OwnershipScope {
  return { own: membershipId === null ? sql`false` : eq(kbPages.ownerMembershipId, membershipId) };
}

export function articleOwnerScopeFilter(read: ScopedRead, user: CurrentUserContext): SQL {
  const membershipId = user.principal === undefined ? null : actingMembershipId(user.principal);
  return read.compose(
    { tenant: kbPages.orgId, scope: articleOwnerScope(membershipId) },
    ({ sql: where }) => where,
    () => sql`false`,
  );
}
