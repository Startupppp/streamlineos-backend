import { ForbiddenException } from "@nestjs/common";
import { resolvePerson } from "../../directory/person-seam";
import type { PayableIdentity, PersonResolutionPath } from "../../directory/person-seam";
import type { PayrollProfileSubject } from "./payroll-subject";
import type { Db } from "../../../db/drizzle.module";

export type PayrollPayee = {
  identity: PayableIdentity;
  subject: PayrollProfileSubject;
  resolvedVia: PersonResolutionPath;
};

function toSubject(identity: PayableIdentity): PayrollProfileSubject {
  if (identity.kind === "user") return { userId: identity.userId, workerId: null };
  return { userId: null, workerId: identity.workerId };
}

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

export async function assertPayrollPersonPayeeEligible(
  db: Db,
  orgId: string,
  organizationPersonId: string,
  message = "Person is not eligible for payroll in this organization",
): Promise<PayrollPayee> {
  const resolution = await resolvePerson(db, orgId, {
    kind: "person",
    organizationPersonId,
  });
  if (resolution.status !== "resolved") throw new ForbiddenException(message);

  const { payableAs, resolvedVia } = resolution.person;
  if (!payableAs) throw new ForbiddenException(message);

  return { identity: payableAs, subject: toSubject(payableAs), resolvedVia };
}
