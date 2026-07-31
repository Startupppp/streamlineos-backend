import { NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { organizationMembers } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

/**
 * `users` is a global table with no `org_id` — membership lives in
 * `organization_members`. Any service that accepts caller-supplied user ids
 * MUST narrow them through here first, or it will happily resolve, email, or
 * grant access to a user belonging to another tenant.
 */
export async function filterOrgMemberIds(
  db: Db,
  orgId: string,
  userIds: readonly string[],
): Promise<string[]> {
  const unique = Array.from(new Set(userIds)).filter(Boolean);
  if (unique.length === 0) return [];

  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.status, "ACTIVE"),
        inArray(organizationMembers.userId, unique),
      ),
    );

  return rows.map((row) => row.userId);
}

export async function isOrgMember(db: Db, orgId: string, userId: string): Promise<boolean> {
  const allowed = await filterOrgMemberIds(db, orgId, [userId]);
  return allowed.length === 1;
}

/**
 * Throws 404 rather than 403 on a foreign id: a 403 would confirm that the user
 * exists in some other tenant.
 */
export async function assertUsersInOrg(
  db: Db,
  orgId: string,
  userIds: readonly string[],
): Promise<void> {
  const unique = Array.from(new Set(userIds)).filter(Boolean);
  if (unique.length === 0) return;

  const allowed = new Set(await filterOrgMemberIds(db, orgId, unique));
  if (unique.some((id) => !allowed.has(id))) {
    throw new NotFoundException("User not found in this organization");
  }
}
