import { eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { kbPages } from "../../db/schema";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

export function pageVisibleTo(user: CurrentUserContext): SQL<unknown> {
  if (user.isOrgOwner || user.isPlatformAdmin) {
    return eq(kbPages.orgId, user.orgId);
  }
  return sql`(${kbPages.visibility} <> 'private' OR ${kbPages.createdById} = ${user.userId})`;
}
