import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { hrEmployeeSensitiveFields, hrEmployments, hrPeople } from "../../db/schema";
import type { DbOrTx } from "../rbac/access-invalidate";
import { encrypt } from "../../modules/hr/onboarding/core/crypto.helpers";

export function monthlyAmountToCents(amount: number): number {
  const rawCents = amount * 100;
  const cents = Math.round(rawCents);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(cents) || Math.abs(rawCents - cents) > 1e-6) {
    throw new BadRequestException("Monthly salary must be a valid amount with at most 2 decimal places");
  }
  return cents;
}

export async function syncCanonicalSensitiveFields(
  db: DbOrTx,
  orgId: string,
  userId: string,
  patch: { monthlySalary?: number; taxId?: string },
): Promise<boolean> {
  const updates: Partial<typeof hrEmployeeSensitiveFields.$inferInsert> = {};
  if (patch.monthlySalary !== undefined) updates.salaryAmountCents = monthlyAmountToCents(patch.monthlySalary);
  if (patch.taxId !== undefined) updates.taxId = patch.taxId ? encrypt(patch.taxId) : "";
  if (Object.keys(updates).length === 0) return true;

  const employmentIds = db
    .select({ id: hrEmployments.id })
    .from(hrEmployments)
    .innerJoin(hrPeople, and(eq(hrPeople.id, hrEmployments.personId), eq(hrPeople.orgId, hrEmployments.orgId)))
    .where(and(
      eq(hrEmployments.orgId, orgId),
      eq(hrEmployments.isPrimary, true),
      isNull(hrEmployments.deletedAt),
      eq(hrPeople.userId, userId),
      isNull(hrPeople.deletedAt),
    ));

  const rows = await db
    .update(hrEmployeeSensitiveFields)
    .set({ ...updates, updatedAt: new Date() })
    .where(and(
      eq(hrEmployeeSensitiveFields.orgId, orgId),
      inArray(hrEmployeeSensitiveFields.employmentId, employmentIds),
    ))
    .returning({ id: hrEmployeeSensitiveFields.id });
  return rows.length > 0;
}
