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
import { encrypt, decrypt } from "../onboarding/core/crypto.helpers";
import { resolveCompatibleList } from "../../../common/db/expand-contract-compat";
import { loadSensitiveRecordCollections } from "./hr-sensitive-record-compat";

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

function decryptRow(row: SensitiveRow): SensitiveRow {
  const out = { ...row };
  for (const field of ENCRYPTED_FIELDS) {
    const value = out[field];
    if (typeof value === "string" && value !== "") {
      out[field] = decrypt(value);
    }
  }
  return out;
}

@Injectable()
export class HrSensitiveService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async get(orgId: string, employmentId: number, actorId: string, ipAddress?: string) {
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
      .select()
      .from(hrEmployeeSensitiveFields)
      .where(
        and(
          eq(hrEmployeeSensitiveFields.employmentId, employmentId),
          eq(hrEmployeeSensitiveFields.orgId, orgId),
        ),
      )
      .limit(1);

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_employee_sensitive_fields",
      entityId: String(employmentId),
      action: "sensitive.viewed",
      ipAddress,
    });

    return row ? this.resolveSensitiveRecordCollections(orgId, decryptRow(row)) : null;
  }

  async update(
    orgId: string,
    employmentId: number,
    actorId: string,
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

    let updated: typeof hrEmployeeSensitiveFields.$inferSelect;

    if (!existing) {
      const [inserted] = await this.db
        .insert(hrEmployeeSensitiveFields)
        .values({
          orgId,
          employmentId,
          salaryAmountCents: input.salaryAmountCents ?? null,
          salaryCurrency: input.salaryCurrency ?? null,
          salaryFrequency: input.salaryFrequency ?? null,
          bankDetails: input.bankDetails ?? null,
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
        .returning();
      if (!inserted) throw new Error("Failed to create sensitive record");
      updated = inserted;
    } else {
      const [patched] = await this.db
        .update(hrEmployeeSensitiveFields)
        .set({
          ...(input.salaryAmountCents !== undefined && { salaryAmountCents: input.salaryAmountCents }),
          ...(input.salaryCurrency !== undefined && { salaryCurrency: input.salaryCurrency }),
          ...(input.salaryFrequency !== undefined && { salaryFrequency: input.salaryFrequency }),
          ...(input.bankDetails !== undefined && { bankDetails: input.bankDetails }),
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
        })
        .where(
          and(
            eq(hrEmployeeSensitiveFields.employmentId, employmentId),
            eq(hrEmployeeSensitiveFields.orgId, orgId),
          ),
        )
        .returning();
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

  private async resolveSensitiveRecordCollections(
    organizationId: string,
    sensitiveRow: SensitiveRow,
  ): Promise<SensitiveRow> {
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
