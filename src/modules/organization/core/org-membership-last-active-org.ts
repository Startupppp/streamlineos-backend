import { and, desc, eq, isNull } from "drizzle-orm";
import {
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { withIdentity } from "../../../common/tenant/with-identity";
import { runOutsideTenantContext } from "../../../common/tenant/tenant-context";
import type { MemberLifecycleStatus } from "./member-lifecycle.types";
import type { Db } from "../../../db/drizzle.module";

export async function planLastActiveOrganizationChange(
  db: Db,
  userId: string,
  affectedOrgId: string,
  nextStatus: MemberLifecycleStatus,
): Promise<{
  previousOrgId: string | null;
  nextOrgId: string | null;
} | null> {
  if (nextStatus === "suspended") return null;

  const rows = await runOutsideTenantContext(() =>
    withIdentity(db, userId, (tx) =>
      tx
        .select({
          previousOrgId: users.lastActiveOrgId,
          activeOrgId: organizations.id,
        })
        .from(users)
        .leftJoin(
          organizationMembers,
          and(
            eq(organizationMembers.userId, users.id),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .leftJoin(
          organizations,
          and(
            eq(organizations.id, organizationMembers.orgId),
            eq(organizations.status, "ACTIVE"),
            isNull(organizations.deletedAt),
          ),
        )
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .orderBy(desc(organizationMembers.joinedAt))
      .limit(100),
    ),
  );

  if (rows.length === 0) return null;

  const previousOrgId = rows[0]?.previousOrgId ?? null;
  const activeOrgIds = rows
    .map((row) => row.activeOrgId)
    .filter((orgId): orgId is string => typeof orgId === "string");
  const eligibleOrgIds =
    nextStatus === "active"
      ? [affectedOrgId, ...activeOrgIds.filter((id) => id !== affectedOrgId)]
      : activeOrgIds.filter((id) => id !== affectedOrgId);

  if (previousOrgId && eligibleOrgIds.includes(previousOrgId)) return null;

  return {
    previousOrgId,
    nextOrgId: eligibleOrgIds[0] ?? null,
  };
}

export async function applyLastActiveOrganizationChange(
  tx: DbOrTx,
  userId: string,
  change: {
    previousOrgId: string | null;
    nextOrgId: string | null;
  } | null,
): Promise<void> {
  if (!change) return;

  await tx
    .update(users)
    .set({ lastActiveOrgId: change.nextOrgId })
    .where(
      and(
        eq(users.id, userId),
        isNull(users.deletedAt),
        change.previousOrgId === null
          ? isNull(users.lastActiveOrgId)
          : eq(users.lastActiveOrgId, change.previousOrgId),
      ),
    );
}
