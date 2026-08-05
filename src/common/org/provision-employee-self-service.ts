import { leaveTypes } from "../../db/schema";
import type { TenantTx } from "../tenant/with-tenant";

export const DEFAULT_LEAVE_TYPES = [
  { name: "Casual Leave", daysPerYear: 12, carryForward: false },
  { name: "Sick Leave", daysPerYear: 12, carryForward: false },
  { name: "Earned Leave", daysPerYear: 15, carryForward: true },
  { name: "Maternity Leave", daysPerYear: 182, carryForward: false },
  { name: "Paternity Leave", daysPerYear: 5, carryForward: false },
] as const;

/**
 * Provisions the minimum organization-owned data required by universal employee
 * self-service. This is deliberately independent of optional product modules.
 */
export async function provisionEmployeeSelfService(
  tx: TenantTx,
  orgId: string,
): Promise<number> {
  const inserted = await tx
    .insert(leaveTypes)
    .values(DEFAULT_LEAVE_TYPES.map((leaveType) => ({ orgId, ...leaveType })))
    .onConflictDoNothing()
    .returning({ id: leaveTypes.id });

  return inserted.length;
}
