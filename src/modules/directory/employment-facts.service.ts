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
  liveEmployment,
  livePerson,
  livePersonOfEmployment,
  livePersonOfUser,
  managerEmploymentOfLine,
  primaryEmploymentOfPerson,
  reportingLineOfEmployment,
  currentPrimaryReportingLine,
} from "./employment-query";
import {
  emptyEmploymentFacts,
  emptySensitiveEmploymentFacts,
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
  panNumber: string | null;
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
      .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
      .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
      .leftJoin(hrReportingLines, reportingLineOfEmployment(orgId))
      .leftJoin(
        managerEmployment,
        managerEmploymentOfLine(orgId, hrReportingLines, managerEmployment),
      )
      .leftJoin(
        managerPerson,
        livePersonOfEmployment(orgId, managerEmployment, managerPerson),
      )
      .where(inArray(users.id, wanted))
      .orderBy(hrEmployments.id);

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
    return facts.get(userId) ?? emptySensitiveEmploymentFacts(userId);
  }

  async getDirectReportUserIds(orgId: string, managerUserId: string): Promise<string[]> {
    const reportPerson = alias(hrPeople, "employment_facts_report_person");
    const reportEmployment = alias(hrEmployments, "employment_facts_report_employment");

    const rows = await this.db
      .selectDistinct({ userId: reportPerson.userId })
      .from(hrReportingLines)
      .innerJoin(
        managerEmployment,
        managerEmploymentOfLine(orgId, hrReportingLines, managerEmployment),
      )
      .innerJoin(
        managerPerson,
        livePersonOfEmployment(orgId, managerEmployment, managerPerson),
      )
      .innerJoin(
        reportEmployment,
        and(
          liveEmployment(orgId, reportEmployment),
          eq(reportEmployment.id, hrReportingLines.employmentId),
        ),
      )
      .innerJoin(
        reportPerson,
        livePersonOfEmployment(orgId, reportEmployment, reportPerson),
      )
      .where(
        and(
          currentPrimaryReportingLine(orgId),
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
        panNumber: hrEmployeeSensitiveFields.panNumber,
      })
      .from(hrPeople)
      .innerJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
      .leftJoin(
        hrEmployeeSensitiveFields,
        and(
          eq(hrEmployeeSensitiveFields.orgId, orgId),
          eq(hrEmployeeSensitiveFields.employmentId, hrEmployments.id),
        ),
      )
      .where(
        and(
          livePerson(orgId),
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
        panNumber: row.panNumber ? readSensitive(row.panNumber) : null,
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
        panNumber: hrEmployeeSensitiveFields.panNumber,
      })
      .from(users)
      .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
      .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
      .leftJoin(
        hrEmployeeSensitiveFields,
        and(
          eq(hrEmployeeSensitiveFields.orgId, orgId),
          eq(hrEmployeeSensitiveFields.employmentId, hrEmployments.id),
        ),
      )
      .where(inArray(users.id, wanted))
      .orderBy(hrEmployments.id);

    for (const row of rows) {
      resolved.set(row.userId, {
        userId: row.userId,
        employmentId: row.employmentId,
        salaryAmountCents: row.salaryAmountCents,
        bankDetails: row.bankDetails ? readBankDetails(row.bankDetails) : null,
        taxId: row.taxId ? readSensitive(row.taxId) : null,
        panNumber: row.panNumber ? readSensitive(row.panNumber) : null,
      });
    }

    for (const userId of wanted)
      if (!resolved.has(userId)) resolved.set(userId, emptySensitiveEmploymentFacts(userId));

    return resolved;
  }

}
