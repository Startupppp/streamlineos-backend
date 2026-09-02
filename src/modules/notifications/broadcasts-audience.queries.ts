import { and, asc, eq, exists, gt, inArray, sql } from "drizzle-orm";
import {
  broadcastAudienceTargets,
  hrEmployments,
  hrPeople,
  organizationMembers,
  roleAssignments,
} from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

const PAGE_SIZE = 500;

async function fetchTargetIds(
  db: Db,
  orgId: string,
  broadcastId: number,
  kind: "ROLE" | "DEPARTMENT" | "USER",
): Promise<string[]> {
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
  return [...new Set(rows.map((r) => r.targetId).filter((v): v is string => typeof v === "string" && v.length > 0))];
}

export async function* pageBroadcastRecipients(
  db: Db,
  orgId: string,
  broadcastId: number,
  audienceType: "all" | "roles" | "departments" | "users",
): AsyncGenerator<string[]> {
  if (audienceType === "users") {
    const ids = await fetchTargetIds(db, orgId, broadcastId, "USER");
    if (ids.length === 0) return;
    let cursor = 0;
    for (;;) {
      const rows = await db
        .select({ userId: organizationMembers.userId, id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, ids), gt(organizationMembers.id, cursor)))
        .orderBy(asc(organizationMembers.id))
        .limit(PAGE_SIZE);
      if (rows.length === 0) return;
      yield rows.map((r) => r.userId);
      if (rows.length < PAGE_SIZE) return;
      const last = rows.at(-1);
      if (!last) return;
      cursor = last.id;
    }
  }

  if (audienceType === "roles") {
    const roleTargetIds = await fetchTargetIds(db, orgId, broadcastId, "ROLE");
    const roleIds = roleTargetIds.map(Number).filter((n) => Number.isFinite(n) && Number.isInteger(n));
    if (roleIds.length === 0) return;
    let cursor = 0;
    for (;;) {
      const rows = await db
        .select({ userId: organizationMembers.userId, id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            gt(organizationMembers.id, cursor),
            exists(
              db
                .select({ _: sql<number>`1` })
                .from(roleAssignments)
                .where(
                  and(
                    eq(roleAssignments.orgId, orgId),
                    eq(roleAssignments.organizationMembershipId, organizationMembers.id),
                    inArray(roleAssignments.roleId, roleIds),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(organizationMembers.id))
        .limit(PAGE_SIZE);
      if (rows.length === 0) return;
      yield rows.map((r) => r.userId);
      if (rows.length < PAGE_SIZE) return;
      const last = rows.at(-1);
      if (!last) return;
      cursor = last.id;
    }
  }

  if (audienceType === "departments") {
    const deptIds = await fetchTargetIds(db, orgId, broadcastId, "DEPARTMENT");
    if (deptIds.length === 0) return;
    const deptSql = sql.join(deptIds.map((id) => sql`${id}`), sql`, `);
    let cursor = 0;
    for (;;) {
      const rows = await db
        .select({ userId: organizationMembers.userId, id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            gt(organizationMembers.id, cursor),
            sql`EXISTS (
              SELECT 1
              FROM ${hrPeople} hp
              INNER JOIN ${hrEmployments} he ON he.person_id = hp.id
                AND he.org_id = ${orgId}
                AND he.is_primary = true
                AND he.deleted_at IS NULL
                AND he.department_id IN (${deptSql})
              WHERE hp.user_id = ${organizationMembers.userId}
                AND hp.org_id = ${orgId}
                AND hp.deleted_at IS NULL
            )`,
          ),
        )
        .orderBy(asc(organizationMembers.id))
        .limit(PAGE_SIZE);
      if (rows.length === 0) return;
      yield rows.map((r) => r.userId);
      if (rows.length < PAGE_SIZE) return;
      const last = rows.at(-1);
      if (!last) return;
      cursor = last.id;
    }
  }

  let cursor = 0;
  for (;;) {
    const rows = await db
      .select({ userId: organizationMembers.userId, id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), gt(organizationMembers.id, cursor)))
      .orderBy(asc(organizationMembers.id))
      .limit(PAGE_SIZE);
    if (rows.length === 0) return;
    yield rows.map((r) => r.userId);
    if (rows.length < PAGE_SIZE) return;
    const last = rows.at(-1);
    if (!last) return;
    cursor = last.id;
  }
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
