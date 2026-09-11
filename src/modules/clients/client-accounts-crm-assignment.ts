import { and, asc, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { bulkUpdateFromValues, type BulkUpdateRow } from "../../common/db/bulk-update";
import { clientAccounts, users } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import type { AccessService } from "../access/access.service";

const CS_PERMISSION = "support:tickets:manage";
const CS_MEMBER_LIMIT = 500;

export async function getCrmAssignmentStats(db: Db, access: AccessService, orgId: string) {
  const csMemberIds = (await access.membersWithPermission(orgId, CS_PERMISSION, { limit: CS_MEMBER_LIMIT })).map((m) => m.userId);

  if (csMemberIds.length === 0) {
    return { members: [], unassignedCount: 0 };
  }

  const csMembers = await db
    .select({ userId: users.id, name: users.name, image: users.image })
    .from(users)
    .where(inArray(users.id, csMemberIds))
    .limit(CS_MEMBER_LIMIT);

  const memberIds = csMembers.map((m) => m.userId);

  const [countRows, [unassignedResult]] = await Promise.all([
    db
      .select({
        userId: clientAccounts.assignedCrmId,
        totalCount: count(),
        activeCount: sql<number>`count(*) FILTER (WHERE ${clientAccounts.status} != 'INVESTED')`,
      })
      .from(clientAccounts)
      .where(and(eq(clientAccounts.orgId, orgId), inArray(clientAccounts.assignedCrmId, memberIds)))
      .groupBy(clientAccounts.assignedCrmId),
    db
      .select({ count: count() })
      .from(clientAccounts)
      .where(and(eq(clientAccounts.orgId, orgId), isNull(clientAccounts.assignedCrmId))),
  ]);

  const countMap = new Map(countRows.map((r) => [r.userId, r]));

  return {
    members: csMembers.map((m) => ({
      userId: m.userId,
      name: m.name,
      image: m.image,
      activeCount: Number(countMap.get(m.userId)?.activeCount ?? 0),
      totalCount: countMap.get(m.userId)?.totalCount ?? 0,
    })),
    unassignedCount: unassignedResult?.count ?? 0,
  };
}

export async function backfillCrmAssignments(db: Db, access: AccessService, orgId: string): Promise<void> {
  const csMembers = await access.membersWithPermission(orgId, CS_PERMISSION, { limit: CS_MEMBER_LIMIT });

  if (csMembers.length === 0) return;

  const memberIds = csMembers.map((m) => m.userId);

  const countRows = await db
    .select({ userId: clientAccounts.assignedCrmId, activeCount: count() })
    .from(clientAccounts)
    .where(
      and(
        eq(clientAccounts.orgId, orgId),
        inArray(clientAccounts.assignedCrmId, memberIds),
        sql`${clientAccounts.status} != 'INVESTED'`,
      ),
    )
    .groupBy(clientAccounts.assignedCrmId);

  const counts: Record<string, number> = Object.fromEntries(memberIds.map((id) => [id, 0]));
  for (const row of countRows) {
    if (row.userId) counts[row.userId] = row.activeCount;
  }

  const BACKFILL_CHUNK = 500;
  let afterId = 0;
  for (;;) {
    const chunk = await db
      .select({ id: clientAccounts.id })
      .from(clientAccounts)
      .where(
        and(
          eq(clientAccounts.orgId, orgId),
          isNull(clientAccounts.assignedCrmId),
          gt(clientAccounts.id, afterId),
        ),
      )
      .orderBy(asc(clientAccounts.id))
      .limit(BACKFILL_CHUNK);

    if (chunk.length === 0) break;

    const assignments: Record<string, number[]> = {};
    for (const account of chunk) {
      let minCount = Infinity;
      let assignee: string | null = null;
      for (const id of memberIds) {
        if ((counts[id] ?? 0) < minCount) {
          minCount = counts[id] ?? 0;
          assignee = id;
        }
      }
      if (assignee) {
        (assignments[assignee] ??= []).push(account.id);
        counts[assignee] = (counts[assignee] ?? 0) + 1;
      }
    }

    const rows: BulkUpdateRow[] = [];
    for (const [assigneeId, ids] of Object.entries(assignments))
      for (const id of ids) rows.push({ key: id, values: [assigneeId] });

    if (rows.length > 0) {
      await bulkUpdateFromValues(db, {
        table: clientAccounts,
        orgId,
        key: { column: "id", type: "integer" },
        columns: [{ column: "assigned_crm_id", type: "text" }],
        rows,
        touch: ["updated_at"],
      });
    }

    const last = chunk[chunk.length - 1];
    if (chunk.length < BACKFILL_CHUNK || last === undefined) break;
    afterId = last.id;
  }
}
