import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { organizationMembers } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { ORG_MEMBER_ROLES } from "../rbac/org-roles";

/** One page of the drain. A page, never a cap: see `getOrgAdminUserIds`. */
const ADMIN_PAGE_SIZE = 500;

/**
 * Notification recipients for org-wide administrative events: the owner plus
 * every active ORG_ADMIN. Only ACTIVE memberships are returned, matching
 * `filterOrgMemberIds` — the dispatch engine drops anyone else anyway.
 *
 * Drained by keyset rather than read in one shot. This was an unbounded read of
 * `organization_members` whose only predicate was the org — "an org has few
 * admins" is a convention, not a cap. A cap would be worse than the unbounded
 * read it replaces, because the rows that fell off are administrators who
 * silently stop being told; paging returns every one of them while still
 * bounding each query.
 */
export async function getOrgAdminUserIds(db: Db, orgId: string): Promise<string[]> {
  const userIds = new Set<string>();
  let afterId = 0;
  for (;;) {
    const page = await db
      .select({ id: organizationMembers.id, userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.status, "ACTIVE"),
          inArray(organizationMembers.role, [
            ORG_MEMBER_ROLES.OWNER,
            ORG_MEMBER_ROLES.ORG_ADMIN,
          ]),
          gt(organizationMembers.id, afterId),
        ),
      )
      .orderBy(asc(organizationMembers.id))
      .limit(ADMIN_PAGE_SIZE);

    for (const row of page) userIds.add(row.userId);
    const last = page[page.length - 1];
    if (page.length < ADMIN_PAGE_SIZE || last === undefined)
      return Array.from(userIds);
    afterId = last.id;
  }
}

/** Org admins plus `extraUserIds`, deduped. Used when an actor must also be told. */
export async function getOrgAdminRecipients(
  db: Db,
  orgId: string,
  extraUserIds: readonly (string | null | undefined)[] = [],
): Promise<string[]> {
  const admins = await getOrgAdminUserIds(db, orgId);
  const extras = extraUserIds.filter((id): id is string => Boolean(id));
  return Array.from(new Set([...admins, ...extras]));
}
