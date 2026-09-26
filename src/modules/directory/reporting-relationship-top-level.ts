import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../../common/rbac/access-invalidate";
import { hrTopLevelRoles } from "../../db/schema";
import { TOP_LEVEL_ROLE_HISTORY_CAP } from "./reporting-line.types";


export async function openTopLevelRole(tx: DbOrTx, orgId: string, employmentId: number, reason: string, from: string, actorUserId: string | null): Promise<void> {
  const roles = await rolesFrom(tx, orgId, employmentId, from);
  if (roles.some((role) => role.effectiveFrom <= from)) return;
  await endTopLevelRoles(tx, orgId, employmentId, from, actorUserId);
  await tx.insert(hrTopLevelRoles).values({ orgId, employmentId, reason, effectiveFrom: from, createdBy: actorUserId });
}

/**
 * Ends every top-level exception still in force on or after `from`. One that began earlier closes
 * the day before; one that had not begun yet is closed on its own first day and marked ended, so
 * no row ever ends before it starts.
 */
export async function endTopLevelRoles(tx: DbOrTx, orgId: string, employmentId: number, from: string, actorUserId: string | null): Promise<void> {
  const roles = await rolesFrom(tx, orgId, employmentId, from);
  if (roles.length === 0) return;
  await tx
    .update(hrTopLevelRoles)
    .set({
      effectiveTo: sql`greatest(${hrTopLevelRoles.effectiveFrom}, ${from}::date - 1)`,
      endedAt: new Date(),
      endedBy: actorUserId,
    })
    .where(and(eq(hrTopLevelRoles.orgId, orgId), inArray(hrTopLevelRoles.id, roles.map((role) => role.id))));
}

function rolesFrom(tx: DbOrTx, orgId: string, employmentId: number, from: string) {
  return tx
    .select({ id: hrTopLevelRoles.id, effectiveFrom: hrTopLevelRoles.effectiveFrom })
    .from(hrTopLevelRoles)
    .where(
      and(
        eq(hrTopLevelRoles.orgId, orgId),
        eq(hrTopLevelRoles.employmentId, employmentId),
        sql`${hrTopLevelRoles.effectiveTo} >= ${from}::date`,
      ),
    )
    .limit(TOP_LEVEL_ROLE_HISTORY_CAP);
}
