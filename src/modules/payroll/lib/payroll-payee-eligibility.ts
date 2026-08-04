import { ForbiddenException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { organizationMembers, organizationPeople, workers } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

export async function assertPayrollPayeeEligible(
  db: Db,
  orgId: string,
  userId: string,
  message = "Person is not eligible for payroll in this organization",
): Promise<void> {
  const membership = await db.query.organizationMembers.findFirst({
    where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
    columns: { id: true },
  });
  if (membership) return;

  const [payeeWorker] = await db
    .select({ workerId: workers.workerId })
    .from(workers)
    .innerJoin(
      organizationPeople,
      and(
        eq(workers.organizationPersonId, organizationPeople.organizationPersonId),
        eq(workers.organizationId, organizationPeople.organizationId),
      ),
    )
    .where(
      and(
        eq(workers.organizationId, orgId),
        eq(organizationPeople.userId, userId),
        eq(workers.isPayee, true),
        isNull(workers.deletedAt),
      ),
    )
    .limit(1);

  if (payeeWorker) return;

  throw new ForbiddenException(message);
}

export async function assertPayrollWorkerPayeeEligible(
  db: Db,
  orgId: string,
  workerId: string,
  message = "Worker is not eligible for payroll in this organization",
): Promise<{ workerId: string; userId: string | null }> {
  const [row] = await db
    .select({
      workerId: workers.workerId,
      userId: organizationPeople.userId,
    })
    .from(workers)
    .innerJoin(
      organizationPeople,
      and(
        eq(workers.organizationPersonId, organizationPeople.organizationPersonId),
        eq(workers.organizationId, organizationPeople.organizationId),
      ),
    )
    .where(
      and(
        eq(workers.organizationId, orgId),
        eq(workers.workerId, workerId),
        eq(workers.isPayee, true),
        isNull(workers.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ForbiddenException(message);
  }

  return row;
}
