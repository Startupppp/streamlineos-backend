import { and, eq } from "drizzle-orm";
import { hrEmployments, hrPeople } from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { liveEmployment, livePersonOfEmployment } from "../../directory/employment-query";

export const EMPLOYEE_ADMISSION_STATUSES = [
  "available",
  "member-without-employment",
  "employee",
  "archived-member",
] as const;

export type EmployeeAdmissionStatus = (typeof EMPLOYEE_ADMISSION_STATUSES)[number];

export const ALREADY_EMPLOYEE_MESSAGE =
  "This person already has an active employment record in this organization. Open their employee profile to change it.";

export const ATTACH_CONFIRMATION_REQUIRED_MESSAGE =
  "This person is already a member of this organization. Confirm attaching employment to their existing account instead of creating a new one.";

export async function findLivePrimaryEmploymentId(
  executor: DbOrTx,
  orgId: string,
  userId: string,
): Promise<number | null> {
  const [row] = await executor
    .select({ employmentId: hrEmployments.id })
    .from(hrEmployments)
    .innerJoin(hrPeople, livePersonOfEmployment(orgId))
    .where(
      and(
        liveEmployment(orgId),
        eq(hrEmployments.isPrimary, true),
        eq(hrPeople.userId, userId),
      ),
    )
    .limit(1);
  return row?.employmentId ?? null;
}
