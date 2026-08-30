import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { hrEmployeeSensitiveFields, hrEmployments, hrPeople } from "../../db/schema";
import type { DbOrTx } from "../rbac/access-invalidate";
import { sealSensitive } from "../security/sensitive-field";
import { sealBankDetails, type BankDetails } from "./canonical-bank-details";
import { keyReferenceOf } from "../security/envelope-encryption";

export function monthlyAmountToCents(amount: number): number {
  const rawCents = amount * 100;
  const cents = Math.round(rawCents);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(cents) || Math.abs(rawCents - cents) > 1e-6) {
    throw new BadRequestException("Monthly salary must be a valid amount with at most 2 decimal places");
  }
  return cents;
}

export interface CanonicalSensitivePatch {
  monthlySalary?: number;
  taxId?: string;
  bankDetails?: BankDetails | null;
}

export async function syncCanonicalSensitiveFields(
  db: DbOrTx,
  orgId: string,
  userId: string,
  patch: CanonicalSensitivePatch,
): Promise<boolean> {
  const updates: Partial<typeof hrEmployeeSensitiveFields.$inferInsert> = {};
  if (patch.monthlySalary !== undefined) updates.salaryAmountCents = monthlyAmountToCents(patch.monthlySalary);
  if (patch.taxId !== undefined) updates.taxId = patch.taxId ? sealSensitive(patch.taxId) : "";
  if (patch.bankDetails !== undefined)
    updates.bankDetails = patch.bankDetails ? sealBankDetails(patch.bankDetails) : null;
  if (Object.keys(updates).length === 0) return true;

  const sealed = updates.bankDetails ?? updates.taxId;
  if (typeof sealed === "string" && sealed !== "")
    updates.encryptionKeyRef = keyReferenceOf(sealed);

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
