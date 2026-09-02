import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { hrLegalHolds } from "../../../../db/schema/hr/governance";

export async function isUnderLegalHold(orgId: string, userId: string, db: Db): Promise<boolean> {
  const rows = await db
    .select({ id: hrLegalHolds.id })
    .from(hrLegalHolds)
    .where(
      and(
        eq(hrLegalHolds.orgId, orgId),
        eq(hrLegalHolds.subjectUserId, userId),
        eq(hrLegalHolds.status, "active"),
        isNull(hrLegalHolds.deletedAt),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/** The set form of `isUnderLegalHold`: one indexed probe for every subject in a sweep. */
export async function subjectsUnderLegalHold(
  orgId: string,
  userIds: readonly string[],
  db: Db,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const rows = await db
    .selectDistinct({ subjectUserId: hrLegalHolds.subjectUserId })
    .from(hrLegalHolds)
    .where(
      and(
        eq(hrLegalHolds.orgId, orgId),
        inArray(hrLegalHolds.subjectUserId, [...userIds]),
        eq(hrLegalHolds.status, "active"),
        isNull(hrLegalHolds.deletedAt),
      ),
    );

  const held = new Set<string>();
  for (const row of rows) if (row.subjectUserId !== null) held.add(row.subjectUserId);
  return held;
}
