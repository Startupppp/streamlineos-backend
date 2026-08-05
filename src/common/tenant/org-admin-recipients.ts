import { and, eq, inArray } from "drizzle-orm";
import { organizationMembers } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { ORG_MEMBER_ROLES } from "../rbac/org-roles";

/**
 * Notification recipients for org-wide administrative events: the owner plus
 * every active ORG_ADMIN. Only ACTIVE memberships are returned, matching
 * `filterOrgMemberIds` — the dispatch engine drops anyone else anyway.
 */
export async function getOrgAdminUserIds(db: Db, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.status, "ACTIVE"),
        inArray(organizationMembers.role, [
          ORG_MEMBER_ROLES.OWNER,
          ORG_MEMBER_ROLES.ORG_ADMIN,
        ]),
      ),
    );

  return Array.from(new Set(rows.map((row) => row.userId)));
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
