import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  hrEmployeeSensitiveFields,
  hrEmployments,
} from "../../../db/schema/hr/core-people";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { UpdateSensitiveInput } from "./dto/hr-core.schemas";
import { HrAuditService } from "./hr-audit.service";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { encrypt, decrypt } from "../onboarding/core/crypto.helpers";
import { resolveCompatibleList } from "../../../common/db/expand-contract-compat";
import { loadSensitiveRecordCollections } from "./hr-sensitive-record-compat";
import { sealSensitiveJson } from "../../../common/security/sensitive-field";
import { readBankDetails, type BankDetails } from "../../../common/hr/canonical-bank-details";

type SensitiveRow = typeof hrEmployeeSensitiveFields.$inferSelect;

const ENCRYPTED_FIELDS = [
  "taxId",
  "panNumber",
  "nationalId",
  "passportNumber",
  "medicalNotes",
] as const satisfies readonly (keyof SensitiveRow)[];

function encryptField(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return value;
  return encrypt(value);
}

const SENSITIVE_COLUMNS = {
  id: hrEmployeeSensitiveFields.id,
  orgId: hrEmployeeSensitiveFields.orgId,
  employmentId: hrEmployeeSensitiveFields.employmentId,
  salaryAmountCents: hrEmployeeSensitiveFields.salaryAmountCents,
  salaryCurrency: hrEmployeeSensitiveFields.salaryCurrency,
  salaryFrequency: hrEmployeeSensitiveFields.salaryFrequency,
  bankDetails: hrEmployeeSensitiveFields.bankDetails,
  taxId: hrEmployeeSensitiveFields.taxId,
  panNumber: hrEmployeeSensitiveFields.panNumber,
  nationalId: hrEmployeeSensitiveFields.nationalId,
  passportNumber: hrEmployeeSensitiveFields.passportNumber,
  passportExpiry: hrEmployeeSensitiveFields.passportExpiry,
  visaType: hrEmployeeSensitiveFields.visaType,
  visaExpiry: hrEmployeeSensitiveFields.visaExpiry,
  medicalNotes: hrEmployeeSensitiveFields.medicalNotes,
  bloodGroup: hrEmployeeSensitiveFields.bloodGroup,
  disciplinaryRecords: hrEmployeeSensitiveFields.disciplinaryRecords,
  grievanceRecords: hrEmployeeSensitiveFields.grievanceRecords,
  bgvStatus: hrEmployeeSensitiveFields.bgvStatus,
  bgvCompletedAt: hrEmployeeSensitiveFields.bgvCompletedAt,
  createdAt: hrEmployeeSensitiveFields.createdAt,
  updatedAt: hrEmployeeSensitiveFields.updatedAt,
};

type SensitiveProjection = {
  [K in keyof typeof SENSITIVE_COLUMNS]: SensitiveRow[K];
};

type EncryptedField = (typeof ENCRYPTED_FIELDS)[number];

function decryptRow<T extends { [K in EncryptedField]: string | null }>(row: T): T {
  const decrypted: { [K in EncryptedField]?: string } = {};
  for (const field of ENCRYPTED_FIELDS) {
    const value = row[field];
    if (typeof value === "string" && value !== "") decrypted[field] = decrypt(value);
  }
  return { ...row, ...decrypted };
}

@Injectable()
export class HrSensitiveService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async get(orgId: string, employmentId: number, actorId: string, actorMembershipId?: number | null, ipAddress?: string) {
    const [emp] = await this.db
      .select({ id: hrEmployments.id })
      .from(hrEmployments)
      .where(
        and(
          eq(hrEmployments.id, employmentId),
          eq(hrEmployments.orgId, orgId),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .limit(1);

    if (!emp) throw new NotFoundException("Employment not found");

    const [row] = await this.db
      .select(SENSITIVE_COLUMNS)
      .from(hrEmployeeSensitiveFields)
      .where(
        and(
          eq(hrEmployeeSensitiveFields.employmentId, employmentId),
          eq(hrEmployeeSensitiveFields.orgId, orgId),
        ),
      )
      .limit(1);

    await runInNewTenantTransaction(this.db, orgId, () =>
      this.audit.log({
        orgId,
        actorId,
        actorMembershipId,
        entityType: "hr_employee_sensitive_fields",
        entityId: String(employmentId),
        action: "sensitive.viewed",
        ipAddress,
      }),
    );

    return row ? this.resolveSensitiveRecordCollections(orgId, decryptRow(row)) : null;
  }

  async update(
    orgId: string,
    employmentId: number,
    actorId: string,
    actorMembershipId: number | null | undefined,
    input: UpdateSensitiveInput,
    ipAddress?: string,
  ) {
    const rows = await this.db
      .select({
        empId: hrEmployments.id,
        sensitive: hrEmployeeSensitiveFields,
      })
      .from(hrEmployments)
      .leftJoin(
        hrEmployeeSensitiveFields,
        and(
          eq(hrEmployeeSensitiveFields.employmentId, hrEmployments.id),
          eq(hrEmployeeSensitiveFields.orgId, orgId),
        ),
      )
      .where(
        and(
          eq(hrEmployments.id, employmentId),
          eq(hrEmployments.orgId, orgId),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .limit(1);

    if (!rows[0]) throw new NotFoundException("Employment not found");

    const existing = rows[0].sensitive;

    let updated: SensitiveProjection;

    if (!existing) {
      const [inserted] = await this.db
        .insert(hrEmployeeSensitiveFields)
        .values({
          orgId,
          employmentId,
          salaryAmountCents: input.salaryAmountCents ?? null,
          salaryCurrency: input.salaryCurrency ?? null,
          salaryFrequency: input.salaryFrequency ?? null,
          bankDetails: input.bankDetails !== undefined ? sealSensitiveJson(input.bankDetails) : null,
          taxId: encryptField(input.taxId) ?? null,
          panNumber: encryptField(input.panNumber) ?? null,
          nationalId: encryptField(input.nationalId) ?? null,
          passportNumber: encryptField(input.passportNumber) ?? null,
          passportExpiry: input.passportExpiry ?? null,
          visaType: input.visaType ?? null,
          visaExpiry: input.visaExpiry ?? null,
          medicalNotes: encryptField(input.medicalNotes) ?? null,
          bloodGroup: input.bloodGroup ?? null,
          bgvStatus: input.bgvStatus ?? null,
        })
        .returning(SENSITIVE_COLUMNS);
      if (!inserted) throw new Error("Failed to create sensitive record");
      updated = inserted;
    } else {
      const [patched] = await this.db
        .update(hrEmployeeSensitiveFields)
        .set({
          ...(input.salaryAmountCents !== undefined && { salaryAmountCents: input.salaryAmountCents }),
          ...(input.salaryCurrency !== undefined && { salaryCurrency: input.salaryCurrency }),
          ...(input.salaryFrequency !== undefined && { salaryFrequency: input.salaryFrequency }),
          ...(input.bankDetails !== undefined && { bankDetails: sealSensitiveJson(input.bankDetails) }),
          ...(input.taxId !== undefined && { taxId: encryptField(input.taxId) }),
          ...(input.panNumber !== undefined && { panNumber: encryptField(input.panNumber) }),
          ...(input.nationalId !== undefined && { nationalId: encryptField(input.nationalId) }),
          ...(input.passportNumber !== undefined && {
            passportNumber: encryptField(input.passportNumber),
          }),
          ...(input.passportExpiry !== undefined && { passportExpiry: input.passportExpiry }),
          ...(input.visaType !== undefined && { visaType: input.visaType }),
          ...(input.visaExpiry !== undefined && { visaExpiry: input.visaExpiry }),
          ...(input.medicalNotes !== undefined && { medicalNotes: encryptField(input.medicalNotes) }),
          ...(input.bloodGroup !== undefined && { bloodGroup: input.bloodGroup }),
          ...(input.bgvStatus !== undefined && { bgvStatus: input.bgvStatus }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(hrEmployeeSensitiveFields.employmentId, employmentId),
            eq(hrEmployeeSensitiveFields.orgId, orgId),
          ),
        )
        .returning(SENSITIVE_COLUMNS);
      if (!patched) throw new NotFoundException("Sensitive record not found");
      updated = patched;
    }

    const beforeRedacted = existing
      ? {
          hasSalary: existing.salaryAmountCents !== null,
          hasBankDetails: existing.bankDetails !== null,
          hasTaxId: existing.taxId !== null,
        }
      : null;

    await this.audit.log({
      orgId,
      actorId,
      actorMembershipId,
      entityType: "hr_employee_sensitive_fields",
      entityId: String(employmentId),
      action: "sensitive.updated",
      before: beforeRedacted,
      after: {
        hasSalary: updated.salaryAmountCents !== null,
        hasBankDetails: updated.bankDetails !== null,
        hasTaxId: updated.taxId !== null,
      },
      ipAddress,
    });

    return this.resolveSensitiveRecordCollections(orgId, decryptRow(updated));
  }

  private async resolveSensitiveRecordCollections<
    T extends Pick<SensitiveRow, "id" | "bankDetails" | "disciplinaryRecords" | "grievanceRecords">,
  >(
    organizationId: string,
    sensitiveRow: T,
  ): Promise<Omit<T, "bankDetails"> & { bankDetails: BankDetails | null }> {
    const normalizedCollections = await loadSensitiveRecordCollections(
      this.db,
      organizationId,
      sensitiveRow.id,
    );
    const recordsEqual = (
      legacyRecord: Record<string, unknown>,
      normalizedRecord: Record<string, unknown>,
    ): boolean => JSON.stringify(legacyRecord) === JSON.stringify(normalizedRecord);
    return {
      ...sensitiveRow,
      bankDetails: sensitiveRow.bankDetails ? readBankDetails(sensitiveRow.bankDetails) : null,
      disciplinaryRecords:
        sensitiveRow.disciplinaryRecords === null
          ? null
          : resolveCompatibleList(
              sensitiveRow.disciplinaryRecords,
              normalizedCollections.disciplinaryRecords,
              recordsEqual,
            ),
      grievanceRecords:
        sensitiveRow.grievanceRecords === null
          ? null
          : resolveCompatibleList(
              sensitiveRow.grievanceRecords,
              normalizedCollections.grievanceRecords,
              recordsEqual,
            ),
    };
  }
}
