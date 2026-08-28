import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  hrEmployeeSensitiveFields,
  hrEmployments,
  hrPeople,
  hrReportingLines,
  organizationMembers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { readBankDetails, bankDetailsEqual } from "../../../common/hr/canonical-bank-details";
import { readSensitive } from "../../../common/security/sensitive-field";
import { decryptBankDetails, decrypt as decryptLegacy } from "../onboarding/core/crypto.helpers";
import type { EmploymentFactName } from "../../directory/employment-facts.types";

export type EmploymentDrift = {
  orgId: string;
  userId: string;
  field: EmploymentFactName;
  legacyValue: string;
  canonicalValue: string;
};

export type OrphanedEmploymentFacts = {
  userId: string;
  email: string;
  fields: string[];
};

const managerEmployment = alias(hrEmployments, "reconcile_manager_employment");
const managerPerson = alias(hrPeople, "reconcile_manager_person");

function centsOf(decimalAmount: string): number | null {
  const amount = Number(decimalAmount);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function show(value: unknown): string {
  return value === null || value === undefined ? "∅" : String(value);
}

@Injectable()
export class EmploymentReconciliationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  activeMemberUserIds(orgId: string): Promise<string[]> {
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const rows = await tx
        .selectDistinct({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        );
      return rows.map((row) => row.userId);
    });
  }

  async findOrphanedFacts(
    placedUserIds: ReadonlySet<string>,
  ): Promise<OrphanedEmploymentFacts[]> {
    const rows = await this.db
      .select({
        userId: users.id,
        email: users.email,
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
      .from(users);

    const orphans: OrphanedEmploymentFacts[] = [];
    for (const row of rows) {
      if (placedUserIds.has(row.userId)) continue;
      const fields = (
        [
          ["employeeId", row.employeeId],
          ["designation", row.designation],
          ["joiningDate", row.joiningDate],
          ["orgDepartmentId", row.orgDepartmentId],
          ["branchId", row.branchId],
          ["reportingTo", row.reportingTo],
          ["monthlySalary", row.monthlySalary],
          ["bankDetails", row.bankDetails],
          ["taxId", row.taxId],
        ] as const
      )
        .filter(([, value]) => value !== null && value !== "")
        .map(([name]) => name);
      if (fields.length > 0) orphans.push({ userId: row.userId, email: row.email, fields });
    }
    return orphans;
  }

  async reconcileOrg(orgId: string): Promise<EmploymentDrift[]> {
    const rows = await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx
        .select({
          userId: users.id,
          legacyDesignation: users.designation,
          legacyJoiningDate: users.joiningDate,
          legacyEmployeeId: users.employeeId,
          legacyDepartmentId: users.orgDepartmentId,
          legacyBranchId: users.branchId,
          legacyReportingTo: users.reportingTo,
          legacyMonthlySalary: users.monthlySalary,
          legacyBankDetails: users.bankDetails,
          legacyTaxId: users.taxId,
          employmentId: hrEmployments.id,
          designation: hrEmployments.designation,
          joiningDate: hrEmployments.joiningDate,
          employeeNumber: hrEmployments.employeeNumber,
          departmentId: hrEmployments.departmentId,
          locationId: hrEmployments.locationId,
          managerUserId: managerPerson.userId,
          salaryAmountCents: hrEmployeeSensitiveFields.salaryAmountCents,
          bankDetails: hrEmployeeSensitiveFields.bankDetails,
          taxId: hrEmployeeSensitiveFields.taxId,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .leftJoin(
          hrPeople,
          and(
            eq(hrPeople.orgId, organizationMembers.orgId),
            eq(hrPeople.userId, organizationMembers.userId),
            isNull(hrPeople.deletedAt),
          ),
        )
        .leftJoin(
          hrEmployments,
          and(
            eq(hrEmployments.orgId, organizationMembers.orgId),
            eq(hrEmployments.personId, hrPeople.id),
            eq(hrEmployments.isPrimary, true),
            isNull(hrEmployments.deletedAt),
          ),
        )
        .leftJoin(
          hrEmployeeSensitiveFields,
          and(
            eq(hrEmployeeSensitiveFields.orgId, organizationMembers.orgId),
            eq(hrEmployeeSensitiveFields.employmentId, hrEmployments.id),
          ),
        )
        .leftJoin(
          hrReportingLines,
          and(
            eq(hrReportingLines.orgId, organizationMembers.orgId),
            eq(hrReportingLines.employmentId, hrEmployments.id),
            eq(hrReportingLines.lineType, "primary"),
            sql`${hrReportingLines.effectiveTo} = 'infinity'::date`,
          ),
        )
        .leftJoin(
          managerEmployment,
          and(
            eq(managerEmployment.orgId, organizationMembers.orgId),
            eq(managerEmployment.id, hrReportingLines.managerEmploymentId),
          ),
        )
        .leftJoin(
          managerPerson,
          and(
            eq(managerPerson.orgId, organizationMembers.orgId),
            eq(managerPerson.id, managerEmployment.personId),
          ),
        )
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        ),
    );

    const drift: EmploymentDrift[] = [];
    const add = (
      userId: string,
      field: EmploymentFactName,
      legacyValue: unknown,
      canonicalValue: unknown,
    ): void => {
      drift.push({
        orgId,
        userId,
        field,
        legacyValue: show(legacyValue),
        canonicalValue: show(canonicalValue),
      });
    };

    for (const row of rows) {
      if (row.legacyDesignation && row.legacyDesignation !== row.designation)
        add(row.userId, "designation", row.legacyDesignation, row.designation);
      if (row.legacyJoiningDate && row.legacyJoiningDate !== row.joiningDate)
        add(row.userId, "joiningDate", row.legacyJoiningDate, row.joiningDate);
      if (row.legacyEmployeeId && row.legacyEmployeeId !== row.employeeNumber)
        add(row.userId, "employeeNumber", row.legacyEmployeeId, row.employeeNumber);
      if (row.legacyDepartmentId && row.legacyDepartmentId !== row.departmentId)
        add(row.userId, "departmentId", row.legacyDepartmentId, row.departmentId);
      if (row.legacyBranchId && row.legacyBranchId !== row.locationId)
        add(row.userId, "locationId", row.legacyBranchId, row.locationId);
      if (row.legacyReportingTo && row.legacyReportingTo !== row.managerUserId)
        add(row.userId, "managerUserId", row.legacyReportingTo, row.managerUserId);

      if (row.legacyMonthlySalary) {
        const legacyCents = centsOf(row.legacyMonthlySalary);
        if (legacyCents !== row.salaryAmountCents)
          add(row.userId, "salaryAmountCents", legacyCents, row.salaryAmountCents);
      }

      if (row.legacyBankDetails) {
        const legacy = decryptBankDetails(row.legacyBankDetails);
        const canonical = row.bankDetails ? readBankDetails(row.bankDetails) : null;
        if (!bankDetailsEqual(legacy, canonical))
          add(row.userId, "bankDetails", "<redacted>", canonical ? "<redacted, differs>" : "∅");
      }

      if (row.legacyTaxId) {
        const legacy = decryptLegacy(row.legacyTaxId);
        const canonical = row.taxId ? readSensitive(row.taxId) : null;
        if (legacy !== canonical)
          add(row.userId, "taxId", "<redacted>", canonical ? "<redacted, differs>" : "∅");
      }
    }

    return drift;
  }
}
