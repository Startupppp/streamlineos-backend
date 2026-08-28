import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, isNull, lte } from "drizzle-orm";
import {
  hrAuditLogs,
  hrEmployeeSensitiveFields,
  hrEmployments,
  organizationMembers,
  orgUnits,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { decryptBankDetails } from "../onboarding/core/crypto.helpers";
import { sealBankDetails } from "../../../common/hr/canonical-bank-details";
import { monthlyAmountToCents } from "../../../common/hr/sync-canonical-sensitive-fields";
import { sealSensitive } from "../../../common/security/sensitive-field";
import { keyReferenceOf } from "../../../common/security/envelope-encryption";
import { syncCanonicalReportingLine } from "../../../common/hr/sync-canonical-reporting-line";
import { HrAuditService } from "./hr-audit.service";
import { PersonEmploymentSyncService } from "./person-employment-sync.service";
import {
  BACKFILL_CHECKPOINT_ACTION,
  BACKFILL_UNMAPPABLE_ACTION,
  type BackfillUnmappable,
  type EmploymentBackfillResult,
  type LegacyEmploymentRow,
  emptyBackfillResult,
} from "./employment-backfill.types";

const FETCH_SIZE = 100;

@Injectable()
export class EmploymentBackfillService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sync: PersonEmploymentSyncService,
    private readonly audit: HrAuditService,
  ) {}

  async backfillOrg(orgId: string, actorId: string | null): Promise<EmploymentBackfillResult> {
    const result = emptyBackfillResult();
    const highWatermark = await this.highWatermark(orgId);
    if (highWatermark === null) return result;

    let after = await this.resumePoint(orgId);
    while (after < highWatermark) {
      const batch = await this.loadBatch(orgId, after, highWatermark);
      if (batch.length === 0) break;
      result.scanned += batch.length;

      for (const row of batch) {
        try {
          await runInNewTenantTransaction(this.db, orgId, (tx) =>
            this.applyOne(tx, orgId, actorId, row, result),
          );
        } catch {
          result.errors.push({ userId: row.userId, message: "Employment backfill failed" });
        }
      }

      const last = batch.at(-1);
      if (!last) break;
      after = last.membershipId;
      await this.recordCheckpoint(orgId, actorId, after);
      if (batch.length < FETCH_SIZE) break;
    }

    await this.recordUnmappable(orgId, actorId, result.unmappable);
    return result;
  }

  private async applyOne(
    tx: Db,
    orgId: string,
    actorId: string | null,
    row: LegacyEmploymentRow,
    result: EmploymentBackfillResult,
  ): Promise<void> {
    const ensured = await this.sync.ensureFromUserId(orgId, actorId, row.userId, tx);
    if (!ensured) {
      result.skipped += 1;
      return;
    }
    if (ensured.createdPerson) result.createdPeople += 1;
    if (ensured.createdEmployment) result.createdEmployments += 1;

    const report = (field: BackfillUnmappable["field"], value: string, reason: string): void => {
      result.unmappable.push({ userId: row.userId, field, value, reason });
    };

    const departmentId = await this.resolveUnit(tx, orgId, row.orgDepartmentId);
    if (row.orgDepartmentId && departmentId === null)
      report("orgDepartmentId", row.orgDepartmentId, "names no live organization unit");

    const locationId = await this.resolveUnit(tx, orgId, row.branchId);
    if (row.branchId && locationId === null)
      report("branchId", row.branchId, "names no live organization unit");

    const patch: Partial<typeof hrEmployments.$inferInsert> = {};
    if (row.designation !== null) patch.designation = row.designation;
    if (row.joiningDate !== null) patch.joiningDate = row.joiningDate;
    if (departmentId !== null) patch.departmentId = departmentId;
    if (locationId !== null) patch.locationId = locationId;

    if (Object.keys(patch).length > 0) {
      await tx
        .update(hrEmployments)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(hrEmployments.id, ensured.employmentId), eq(hrEmployments.orgId, orgId)));
      result.fieldsCopied += Object.keys(patch).length;
    }

    const [landed] = await tx
      .select({ employeeNumber: hrEmployments.employeeNumber })
      .from(hrEmployments)
      .where(and(eq(hrEmployments.id, ensured.employmentId), eq(hrEmployments.orgId, orgId)))
      .limit(1);
    const wantedNumber = row.employeeId?.trim();
    if (wantedNumber && landed && landed.employeeNumber !== wantedNumber)
      report(
        "employeeId",
        wantedNumber,
        `collides with uniq_hr_employments_org_emp_num — stored as ${landed.employeeNumber}`,
      );

    await this.applySensitive(tx, orgId, ensured.employmentId, row, result, report);

    if (row.reportingTo !== null) {
      const outcome = await syncCanonicalReportingLine(
        tx,
        orgId,
        row.userId,
        row.reportingTo,
        row.joiningDate ?? new Date().toISOString().slice(0, 10),
        actorId,
      );
      if (outcome.status === "written") result.reportingLinesWritten += 1;
      else if (outcome.status === "unmappable")
        report("reportingTo", row.reportingTo, outcome.reason);
    }
  }

  private async applySensitive(
    tx: Db,
    orgId: string,
    employmentId: number,
    row: LegacyEmploymentRow,
    result: EmploymentBackfillResult,
    report: (field: BackfillUnmappable["field"], value: string, reason: string) => void,
  ): Promise<void> {
    const values: Partial<typeof hrEmployeeSensitiveFields.$inferInsert> = {};

    if (row.monthlySalary !== null) {
      const amount = Number(row.monthlySalary);
      if (Number.isFinite(amount)) values.salaryAmountCents = monthlyAmountToCents(amount);
      else report("monthlySalary", row.monthlySalary, "is not a numeric amount");
    }

    if (row.bankDetails !== null) {
      const details = decryptBankDetails(row.bankDetails);
      if (details) values.bankDetails = sealBankDetails(details);
      else report("bankDetails", "<redacted>", "could not be decrypted or did not match the schema");
    }

    if (row.taxId !== null) values.taxId = sealSensitive(row.taxId);

    if (Object.keys(values).length === 0) return;

    const sealed = values.bankDetails ?? values.taxId;
    if (typeof sealed === "string" && sealed !== "")
      values.encryptionKeyRef = keyReferenceOf(sealed);

    await tx
      .insert(hrEmployeeSensitiveFields)
      .values({ orgId, employmentId, ...values })
      .onConflictDoUpdate({
        target: hrEmployeeSensitiveFields.employmentId,
        set: { ...values, updatedAt: new Date() },
      });
    result.sensitiveRecordsWritten += 1;
  }

  private async resolveUnit(
    tx: Db,
    orgId: string,
    unitId: string | null,
  ): Promise<string | null> {
    if (!unitId) return null;
    const [unit] = await tx
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.id, unitId),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.status, "ACTIVE"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .limit(1);
    return unit?.id ?? null;
  }

  private highWatermark(orgId: string): Promise<number | null> {
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({ membershipId: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.status, "ACTIVE")),
        )
        .orderBy(desc(organizationMembers.id))
        .limit(1);
      return row?.membershipId ?? null;
    });
  }

  private resumePoint(orgId: string): Promise<number> {
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({ after: hrAuditLogs.after })
        .from(hrAuditLogs)
        .where(
          and(
            eq(hrAuditLogs.orgId, orgId),
            eq(hrAuditLogs.action, BACKFILL_CHECKPOINT_ACTION),
          ),
        )
        .orderBy(desc(hrAuditLogs.id))
        .limit(1);
      const raw = (row?.after as Record<string, unknown> | null)?.afterMembershipId;
      return typeof raw === "number" ? raw : 0;
    });
  }

  private loadBatch(
    orgId: string,
    after: number,
    highWatermark: number,
  ): Promise<LegacyEmploymentRow[]> {
    return runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx
        .select({
          membershipId: organizationMembers.id,
          userId: users.id,
          employeeId: users.employeeId,
          designation: users.designation,
          joiningDate: users.joiningDate,
          orgDepartmentId: users.orgDepartmentId,
          branchId: users.branchId,
          reportingTo: users.reportingTo,
          monthlySalary: users.monthlySalary,
          bankDetails: users.bankDetails,
          taxId: users.taxId,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.status, "ACTIVE"),
            gt(organizationMembers.id, after),
            lte(organizationMembers.id, highWatermark),
          ),
        )
        .orderBy(asc(organizationMembers.id))
        .limit(FETCH_SIZE),
    );
  }

  private recordCheckpoint(orgId: string, actorId: string | null, afterMembershipId: number): Promise<void> {
    return runInNewTenantTransaction(this.db, orgId, (tx) =>
      this.audit.log(
        {
          orgId,
          actorId,
          entityType: "hr_employments",
          entityId: orgId,
          action: BACKFILL_CHECKPOINT_ACTION,
          after: { afterMembershipId },
        },
        tx,
      ),
    );
  }

  private async recordUnmappable(
    orgId: string,
    actorId: string | null,
    unmappable: BackfillUnmappable[],
  ): Promise<void> {
    if (unmappable.length === 0) return;
    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      for (const entry of unmappable)
        await this.audit.log(
          {
            orgId,
            actorId,
            entityType: "users",
            entityId: entry.userId,
            action: BACKFILL_UNMAPPABLE_ACTION,
            after: { field: entry.field, value: entry.value, reason: entry.reason },
          },
          tx,
        );
    });
  }
}
