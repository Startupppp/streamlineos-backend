import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, notInArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrEmployments, hrPeople, hrReportingLines, organizationMembers, users } from "../../db/schema";
import { DIRECT_REPORT_ID_CAP } from "./employment-facts.service";
import {
  currentPrimaryReportingLine,
  liveEmployment,
  livePersonOfEmployment,
  managerEmploymentOfLine,
  memberOfOrg,
} from "./employment-query";

export interface DirectReport {
  userId: string;
  membershipId: number | null;
  employmentId: number;
  name: string | null;
  email: string | null;
  designation: string | null;
  joiningDate: string | null;
  probationEndDate: string | null;
  lifecycleStatus: string;
}

const NOT_ON_THE_TEAM = ["CANDIDATE", "EXITED", "ALUMNI"] as const;

const managerEmployment = alias(hrEmployments, "direct_reports_manager_employment");
const managerPerson = alias(hrPeople, "direct_reports_manager_person");
const reportEmployment = alias(hrEmployments, "direct_reports_report_employment");
const reportPerson = alias(hrPeople, "direct_reports_report_person");

@Injectable()
export class DirectReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, managerUserId: string): Promise<DirectReport[]> {
    const rows = await this.db
      .select({
        userId: reportPerson.userId,
        membershipId: organizationMembers.id,
        employmentId: reportEmployment.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        designation: reportEmployment.designation,
        joiningDate: reportEmployment.joiningDate,
        probationEndDate: reportEmployment.probationEndDate,
        lifecycleStatus: reportEmployment.lifecycleStatus,
      })
      .from(hrReportingLines)
      .innerJoin(managerEmployment, managerEmploymentOfLine(orgId, hrReportingLines, managerEmployment))
      .innerJoin(managerPerson, livePersonOfEmployment(orgId, managerEmployment, managerPerson))
      .innerJoin(reportEmployment, and(liveEmployment(orgId, reportEmployment), eq(reportEmployment.id, hrReportingLines.employmentId)))
      .innerJoin(reportPerson, livePersonOfEmployment(orgId, reportEmployment, reportPerson))
      .leftJoin(users, eq(users.id, reportPerson.userId))
      .leftJoin(organizationMembers, and(memberOfOrg(orgId, reportPerson.userId), eq(organizationMembers.status, "ACTIVE")))
      .where(
        and(
          currentPrimaryReportingLine(orgId),
          eq(managerPerson.userId, managerUserId),
          notInArray(reportEmployment.lifecycleStatus, [...NOT_ON_THE_TEAM]),
        ),
      )
      .orderBy(asc(users.name), asc(reportEmployment.id))
      .limit(DIRECT_REPORT_ID_CAP);

    return rows.flatMap((row) => {
      if (row.userId === null) return [];
      const composed = [row.firstName, row.lastName].filter((part): part is string => !!part && part.trim() !== "").join(" ");
      return [
        {
          userId: row.userId,
          membershipId: row.membershipId,
          employmentId: row.employmentId,
          name: row.name?.trim() || composed || null,
          email: row.email,
          designation: row.designation,
          joiningDate: row.joiningDate,
          probationEndDate: row.probationEndDate,
          lifecycleStatus: row.lifecycleStatus,
        },
      ];
    });
  }
}
