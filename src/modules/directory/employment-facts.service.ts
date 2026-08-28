import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  hrEmployeeSensitiveFields,
  hrEmployments,
  hrPeople,
  hrReportingLines,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { readBankDetails } from "../../common/hr/canonical-bank-details";
import { readSensitive } from "../../common/security/sensitive-field";
import {
  emptyEmploymentFacts,
  type EmploymentFactName,
  type EmploymentFacts,
  type SensitiveEmploymentFacts,
} from "./employment-facts.types";

const managerEmployment = alias(hrEmployments, "employment_facts_manager_employment");
const managerPerson = alias(hrPeople, "employment_facts_manager_person");

type FactRow = {
  userId: string;
  employmentId: number | null;
  employeeNumber: string | null;
  designation: string | null;
  joiningDate: string | null;
  departmentId: string | null;
  locationId: string | null;
  managerUserId: string | null;
};

type SensitiveRow = {
  userId: string;
  employmentId: number | null;
  salaryAmountCents: number | null;
  bankDetails: string | null;
  taxId: string | null;
};


@Injectable()
export class EmploymentFactsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getFacts(orgId: string, userId: string): Promise<EmploymentFacts> {
    const facts = await this.getFactsBatch(orgId, [userId]);
    return facts.get(userId) ?? emptyEmploymentFacts(userId);
  }

  async getFactsBatch(
    orgId: string,
    userIds: readonly string[],
  ): Promise<Map<string, EmploymentFacts>> {
    const resolved = new Map<string, EmploymentFacts>();
    const wanted = [...new Set(userIds)].filter((id) => id.length > 0);
    if (wanted.length === 0) return resolved;

    const rows: FactRow[] = await this.db
      .select({
        userId: users.id,
        employmentId: hrEmployments.id,
        employeeNumber: hrEmployments.employeeNumber,
        designation: hrEmployments.designation,
        joiningDate: hrEmployments.joiningDate,
        departmentId: hrEmployments.departmentId,
        locationId: hrEmployments.locationId,
        managerUserId: managerPerson.userId,
      })
      .from(users)
      .leftJoin(
        hrPeople,
        and(
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.userId, users.id),
          isNull(hrPeople.deletedAt),
        ),
      )
      .leftJoin(
        hrEmployments,
        and(
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.personId, hrPeople.id),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .leftJoin(
        hrReportingLines,
        and(
          eq(hrReportingLines.orgId, orgId),
          eq(hrReportingLines.employmentId, hrEmployments.id),
          eq(hrReportingLines.lineType, "primary"),
          sql`${hrReportingLines.effectiveTo} = 'infinity'::date`,
        ),
      )
      .leftJoin(
        managerEmployment,
        and(
          eq(managerEmployment.orgId, orgId),
          eq(managerEmployment.id, hrReportingLines.managerEmploymentId),
        ),
      )
      .leftJoin(
        managerPerson,
        and(eq(managerPerson.orgId, orgId), eq(managerPerson.id, managerEmployment.personId)),
      )
      .where(inArray(users.id, wanted));

    for (const row of rows) {
      resolved.set(row.userId, {
        userId: row.userId,
        employmentId: row.employmentId,
        employeeNumber: row.employeeNumber,
        designation: row.designation,
        joiningDate: row.joiningDate,
        departmentId: row.departmentId,
        locationId: row.locationId,
        managerUserId: row.managerUserId,
      });
    }

    for (const userId of wanted)
      if (!resolved.has(userId)) resolved.set(userId, emptyEmploymentFacts(userId));

    return resolved;
  }

  async getSensitiveFacts(
    orgId: string,
    userId: string,
  ): Promise<SensitiveEmploymentFacts> {
    const facts = await this.getSensitiveFactsBatch(orgId, [userId]);
    return (
      facts.get(userId) ?? {
        userId,
        employmentId: null,
        salaryAmountCents: null,
        bankDetails: null,
        taxId: null,
      }
    );
  }

  async getDirectReportUserIds(orgId: string, managerUserId: string): Promise<string[]> {
    const reportPerson = alias(hrPeople, "employment_facts_report_person");
    const reportEmployment = alias(hrEmployments, "employment_facts_report_employment");

    const rows = await this.db
      .selectDistinct({ userId: reportPerson.userId })
      .from(hrReportingLines)
      .innerJoin(
        managerEmployment,
        and(
          eq(managerEmployment.orgId, orgId),
          eq(managerEmployment.id, hrReportingLines.managerEmploymentId),
        ),
      )
      .innerJoin(
        managerPerson,
        and(eq(managerPerson.orgId, orgId), eq(managerPerson.id, managerEmployment.personId)),
      )
      .innerJoin(
        reportEmployment,
        and(
          eq(reportEmployment.orgId, orgId),
          eq(reportEmployment.id, hrReportingLines.employmentId),
          isNull(reportEmployment.deletedAt),
        ),
      )
      .innerJoin(
        reportPerson,
        and(
          eq(reportPerson.orgId, orgId),
          eq(reportPerson.id, reportEmployment.personId),
          isNull(reportPerson.deletedAt),
        ),
      )
      .where(
        and(
          eq(hrReportingLines.orgId, orgId),
          eq(hrReportingLines.lineType, "primary"),
          sql`${hrReportingLines.effectiveTo} = 'infinity'::date`,
          eq(managerPerson.userId, managerUserId),
        ),
      );

    return rows.map((row) => row.userId).filter((id): id is string => id !== null);
  }

  async getSensitiveFactsByPersonBatch(
    orgId: string,
    organizationPersonIds: readonly string[],
  ): Promise<Map<string, SensitiveEmploymentFacts>> {
    const resolved = new Map<string, SensitiveEmploymentFacts>();
    const wanted = [...new Set(organizationPersonIds)].filter((id) => id.length > 0);
    if (wanted.length === 0) return resolved;

    const rows = await this.db
      .select({
        organizationPersonId: hrPeople.organizationPersonId,
        userId: hrPeople.userId,
        employmentId: hrEmployments.id,
        salaryAmountCents: hrEmployeeSensitiveFields.salaryAmountCents,
        bankDetails: hrEmployeeSensitiveFields.bankDetails,
        taxId: hrEmployeeSensitiveFields.taxId,
      })
      .from(hrPeople)
      .innerJoin(
        hrEmployments,
        and(
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.personId, hrPeople.id),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .leftJoin(
        hrEmployeeSensitiveFields,
        and(
          eq(hrEmployeeSensitiveFields.orgId, orgId),
          eq(hrEmployeeSensitiveFields.employmentId, hrEmployments.id),
        ),
      )
      .where(
        and(
          eq(hrPeople.orgId, orgId),
          isNull(hrPeople.deletedAt),
          inArray(hrPeople.organizationPersonId, wanted),
        ),
      );

    for (const row of rows) {
      if (row.organizationPersonId === null) continue;
      resolved.set(row.organizationPersonId, {
        userId: row.userId ?? "",
        employmentId: row.employmentId,
        salaryAmountCents: row.salaryAmountCents,
        bankDetails: row.bankDetails ? readBankDetails(row.bankDetails) : null,
        taxId: row.taxId ? readSensitive(row.taxId) : null,
      });
    }

    return resolved;
  }

  async getSensitiveFactsBatch(
    orgId: string,
    userIds: readonly string[],
  ): Promise<Map<string, SensitiveEmploymentFacts>> {
    const resolved = new Map<string, SensitiveEmploymentFacts>();
    const wanted = [...new Set(userIds)].filter((id) => id.length > 0);
    if (wanted.length === 0) return resolved;

    const rows: SensitiveRow[] = await this.db
      .select({
        userId: users.id,
        employmentId: hrEmployments.id,
        salaryAmountCents: hrEmployeeSensitiveFields.salaryAmountCents,
        bankDetails: hrEmployeeSensitiveFields.bankDetails,
        taxId: hrEmployeeSensitiveFields.taxId,
      })
      .from(users)
      .leftJoin(
        hrPeople,
        and(
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.userId, users.id),
          isNull(hrPeople.deletedAt),
        ),
      )
      .leftJoin(
        hrEmployments,
        and(
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.personId, hrPeople.id),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .leftJoin(
        hrEmployeeSensitiveFields,
        and(
          eq(hrEmployeeSensitiveFields.orgId, orgId),
          eq(hrEmployeeSensitiveFields.employmentId, hrEmployments.id),
        ),
      )
      .where(inArray(users.id, wanted));

    for (const row of rows) {
      const canonicalBank = row.bankDetails ? readBankDetails(row.bankDetails) : null;
      const canonicalTax = row.taxId ? readSensitive(row.taxId) : null;
      resolved.set(row.userId, {
        userId: row.userId,
        employmentId: row.employmentId,
        salaryAmountCents: row.salaryAmountCents,
        bankDetails: canonicalBank,
        taxId: canonicalTax,
      });
    }

    for (const userId of wanted)
      if (!resolved.has(userId))
        resolved.set(userId, {
          userId,
          employmentId: null,
          salaryAmountCents: null,
          bankDetails: null,
          taxId: null,
        });

    return resolved;
  }

}
