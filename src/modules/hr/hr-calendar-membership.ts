import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { organizationMembers } from "../../db/schema";

export function findActiveHrCalendarMembership(db: Db, orgId: string, userId: string) {
  return db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.status, "ACTIVE"),
    ),
    columns: { id: true },
  });
}
