import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  kbSpaces,
  kbSpaceMembers,
  roles,
  roleAssignments,
  organizationMembers,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";

export async function resolveRoleSlugs(
  db: Db,
  orgId: string,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ slug: roles.slug })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .innerJoin(
      organizationMembers,
      eq(organizationMembers.id, roleAssignments.organizationMembershipId),
    )
    .where(
      and(
        eq(roleAssignments.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, orgId),
      ),
    );
  return rows.map((r) => r.slug);
}

export async function computeAccessibleSpaceIds(
  db: Db,
  orgId: string,
  membershipId: number | null,
  isAdmin: boolean,
  resolveRoles: () => Promise<string[]>,
): Promise<number[]> {
  const spaces = await db
    .select({ id: kbSpaces.id, audience: kbSpaces.audience })
    .from(kbSpaces)
    .where(and(eq(kbSpaces.orgId, orgId), isNull(kbSpaces.deletedAt)));

  if (isAdmin) return spaces.map((s) => s.id);
  if (membershipId === null) return [];

  const roleSlugs = await resolveRoles();
  const directMatch = eq(kbSpaceMembers.membershipId, membershipId);
  const grantedRows = await db
    .selectDistinct({ spaceId: kbSpaceMembers.spaceId })
    .from(kbSpaceMembers)
    .where(
      and(
        eq(kbSpaceMembers.orgId, orgId),
        roleSlugs.length > 0
          ? or(directMatch, inArray(kbSpaceMembers.role, roleSlugs))
          : directMatch,
      ),
    );

  const granted = new Set(grantedRows.map((m) => m.spaceId));
  return spaces
    .filter(
      (s) =>
        s.audience === "public" || s.audience === "mixed" || granted.has(s.id),
    )
    .map((s) => s.id);
}
