import { ForbiddenException } from "@nestjs/common";
import { resolvePerson } from "../../directory/person-seam";
import type { Db } from "../../../db/drizzle.module";

export async function assertPayrollPayeeEligible(
  db: Db,
  orgId: string,
  userId: string,
  message = "Person is not eligible for payroll in this organization",
): Promise<void> {
  const resolution = await resolvePerson(db, orgId, { kind: "user", userId });
  if (resolution.status !== "resolved" || !resolution.person.payable)
    throw new ForbiddenException(message);
}

export async function assertPayrollWorkerPayeeEligible(
  db: Db,
  orgId: string,
  workerId: string,
  message = "Worker is not eligible for payroll in this organization",
): Promise<{ workerId: string; userId: string | null }> {
  const resolution = await resolvePerson(db, orgId, { kind: "worker", workerId });
  if (resolution.status !== "resolved" || !resolution.person.payable)
    throw new ForbiddenException(message);

  return {
    workerId: resolution.person.workerId ?? workerId,
    userId: resolution.person.userId,
  };
}
