import { and, eq, inArray, sql } from "drizzle-orm";
import {
  broadcastAudienceTargets,
  hrEmployments,
  hrPeople,
  organizationMembers,
  roleAssignments,
  users,
} from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

export async function resolveBroadcastRecipients(
  db: Db,
  orgId: string,
  broadcastId: number,
  audienceType: "all" | "roles" | "departments" | "users",
): Promise<string[]> {
  const dedupe = (ids: string[]): string[] => [...new Set(ids.filter(Boolean))];

  const targetIds = async (kind: "ROLE" | "DEPARTMENT" | "USER"): Promise<string[]> => {
    const rows = await db
      .select({ targetId: broadcastAudienceTargets.targetId })
      .from(broadcastAudienceTargets)
      .where(
        and(
          eq(broadcastAudienceTargets.orgId, orgId),
          eq(broadcastAudienceTargets.broadcastId, broadcastId),
          eq(broadcastAudienceTargets.kind, kind),
        ),
      );
    return dedupe(rows.map((r) => r.targetId));
  };

  if (audienceType === "users") {
    const ids = await targetIds("USER");
    if (ids.length === 0) return [];
    const rows = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, ids)));
    return dedupe(rows.map((r) => r.userId));
  }

  if (audienceType === "roles") {
    const roleIds = (await targetIds("ROLE")).map(Number).filter((n) => Number.isInteger(n));
    if (roleIds.length === 0) return [];
    const rows = await db
      .select({ userId: organizationMembers.userId })
      .from(roleAssignments)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, roleAssignments.orgId),
          eq(organizationMembers.id, roleAssignments.organizationMembershipId),
        ),
      )
      .where(and(eq(roleAssignments.orgId, orgId), inArray(roleAssignments.roleId, roleIds)));
    return dedupe(rows.map((r) => r.userId));
  }

  if (audienceType === "departments") {
    const deptIds = await targetIds("DEPARTMENT");
    if (deptIds.length === 0) return [];
    const deptSql = sql.join(deptIds.map((id) => sql`${id}`), sql`, `);
    const rows = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .innerJoin(
        users,
        and(
          eq(users.id, organizationMembers.userId),
          sql`EXISTS (
            SELECT 1
            FROM ${hrPeople} hp
            INNER JOIN ${hrEmployments} he ON he.person_id = hp.id
              AND he.org_id = ${orgId}
              AND he.is_primary = true
              AND he.deleted_at IS NULL
              AND he.department_id IN (${deptSql})
            WHERE hp.user_id = ${users.id}
              AND hp.org_id = ${orgId}
              AND hp.deleted_at IS NULL
          )`,
        ),
      )
      .where(eq(organizationMembers.orgId, orgId));
    return dedupe(rows.map((r) => r.userId));
  }

  const memberships = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));
  return dedupe(memberships.map((m) => m.userId));
}

export async function replaceBroadcastAudienceTargets(
  tx: Db,
  orgId: string,
  broadcastId: number,
  audience: { type: string; roleIds?: string[]; departmentIds?: string[]; userIds?: string[] },
): Promise<void> {
  await tx
    .delete(broadcastAudienceTargets)
    .where(
      and(
        eq(broadcastAudienceTargets.orgId, orgId),
        eq(broadcastAudienceTargets.broadcastId, broadcastId),
      ),
    );

  const rows: Array<{
    orgId: string;
    broadcastId: number;
    kind: "ROLE" | "DEPARTMENT" | "USER";
    targetId: string;
  }> = [];
  const add = (kind: "ROLE" | "DEPARTMENT" | "USER", ids: string[] | undefined) => {
    for (const targetId of new Set(ids ?? []))
      if (targetId) rows.push({ orgId, broadcastId, kind, targetId });
  };
  add("ROLE", audience.roleIds);
  add("DEPARTMENT", audience.departmentIds);
  add("USER", audience.userIds);
  if (rows.length > 0) await tx.insert(broadcastAudienceTargets).values(rows);
}
