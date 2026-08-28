import { and, eq, inArray, isNull } from "drizzle-orm";
import { hrEmployments, hrPeople } from "../../db/schema";
import type { DbOrTx } from "../rbac/access-invalidate";

export interface CanonicalEmploymentPatch {
  designation?: string | null;
  departmentId?: string | null;
  joiningDate?: string | null;
  locationId?: string | null;
  employeeNumber?: string | null;
}

export async function syncCanonicalEmploymentFields(
  db: DbOrTx,
  orgId: string,
  userId: string,
  patch: CanonicalEmploymentPatch,
): Promise<boolean> {
  const updates: Partial<typeof hrEmployments.$inferInsert> = {};
  if (patch.designation !== undefined) updates.designation = patch.designation;
  if (patch.departmentId !== undefined) updates.departmentId = patch.departmentId;
  if (patch.joiningDate !== undefined) updates.joiningDate = patch.joiningDate;
  if (patch.locationId !== undefined) updates.locationId = patch.locationId;
  if (patch.employeeNumber != null && patch.employeeNumber !== "")
    updates.employeeNumber = patch.employeeNumber;
  if (Object.keys(updates).length === 0) return true;

  const personIds = db
    .select({ id: hrPeople.id })
    .from(hrPeople)
    .where(
      and(
        eq(hrPeople.orgId, orgId),
        eq(hrPeople.userId, userId),
        isNull(hrPeople.deletedAt),
      ),
    );
  const rows = await db
    .update(hrEmployments)
    .set({ ...updates, updatedAt: new Date() })
    .where(
      and(
        eq(hrEmployments.orgId, orgId),
        eq(hrEmployments.isPrimary, true),
        isNull(hrEmployments.deletedAt),
        inArray(hrEmployments.personId, personIds),
      ),
    )
    .returning({ id: hrEmployments.id });
  return rows.length > 0;
}
