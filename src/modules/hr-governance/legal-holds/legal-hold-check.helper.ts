import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { hrLegalHolds } from "../../../db/schema/hr/governance";

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
