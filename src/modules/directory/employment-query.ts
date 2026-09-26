import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";
import {
  hrEmployments,
  hrPeople,
  hrReportingLines,
  organizationMembers,
  orgUnits,
} from "../../db/schema";
import type { Db, TenantTx } from "../../db/drizzle.types";

/**
 * Structural, not `typeof hrEmployments`, because a self-join needs `alias()` and
 * an aliased table carries the alias in `_.config.name` — so it is never
 * assignable to the concrete table type. Every helper here reads columns only,
 * and the file already types `unitId` and `UserIdRef` this way.
 */
type PeopleTable = {
  id: PgColumn;
  orgId: PgColumn;
  userId: PgColumn;
  deletedAt: PgColumn;
};
type UserIdRef = PgColumn | string;
type OrgUnitsTable = { id: PgColumn; orgId: PgColumn };
type EmploymentsTable = {
  id: PgColumn;
  orgId: PgColumn;
  personId: PgColumn;
  isPrimary: PgColumn;
  deletedAt: PgColumn;
};
type ReportingLinesTable = {
  orgId: PgColumn;
  lineType: PgColumn;
  effectiveFrom: PgColumn;
  effectiveTo: PgColumn;
  employmentId: PgColumn;
  managerEmploymentId: PgColumn;
};

/** `users` is global, so any read that starts there must re-enter the tenant. */
export function memberOfOrg(orgId: string, userId: UserIdRef): SQL {
  const condition = and(
    eq(organizationMembers.orgId, orgId),
    eq(organizationMembers.userId, userId),
  );
  if (!condition) throw new Error("memberOfOrg produced no condition");
  return condition;
}

export function livePersonOfUser(
  orgId: string,
  userId: UserIdRef,
  people: PeopleTable = hrPeople,
): SQL {
  const condition = and(
    eq(people.orgId, orgId),
    eq(people.userId, userId),
    isNull(people.deletedAt),
  );
  if (!condition) throw new Error("livePersonOfUser produced no condition");
  return condition;
}

export function livePerson(orgId: string, people: PeopleTable = hrPeople): SQL {
  const condition = and(eq(people.orgId, orgId), isNull(people.deletedAt));
  if (!condition) throw new Error("livePerson produced no condition");
  return condition;
}

export function primaryEmploymentOfPerson(
  orgId: string,
  people: PeopleTable = hrPeople,
  employments: EmploymentsTable = hrEmployments,
): SQL {
  const condition = and(
    eq(employments.orgId, orgId),
    eq(employments.personId, people.id),
    eq(employments.isPrimary, true),
    isNull(employments.deletedAt),
  );
  if (!condition)
    throw new Error("primaryEmploymentOfPerson produced no condition");
  return condition;
}

export function livePersonOfEmployment(
  orgId: string,
  employments: EmploymentsTable = hrEmployments,
  people: PeopleTable = hrPeople,
): SQL {
  const condition = and(
    eq(people.orgId, orgId),
    eq(people.id, employments.personId),
    isNull(people.deletedAt),
  );
  if (!condition)
    throw new Error("livePersonOfEmployment produced no condition");
  return condition;
}

export function liveEmployment(
  orgId: string,
  employments: EmploymentsTable = hrEmployments,
): SQL {
  const condition = and(
    eq(employments.orgId, orgId),
    isNull(employments.deletedAt),
  );
  if (!condition) throw new Error("liveEmployment produced no condition");
  return condition;
}

/**
 * Today in the organization's timezone, evaluated once per statement (`app.org_business_date`,
 * migration 1237). Lines are written from `orgBusinessDate`; reading them against the session's
 * CURRENT_DATE hid a line written "today" until UTC caught up.
 */
export function orgBusinessDateSql(orgId: string): SQL {
  return sql`(SELECT app.org_business_date(${orgId}))`;
}

export function currentPrimaryReportingLine(
  orgId: string,
  lines: ReportingLinesTable = hrReportingLines,
): SQL {
  const condition = and(
    eq(lines.orgId, orgId),
    eq(lines.lineType, "primary"),
    sql`${lines.effectiveFrom} <= ${orgBusinessDateSql(orgId)}`,
    sql`${lines.effectiveTo} >= ${orgBusinessDateSql(orgId)}`,
  );
  if (!condition)
    throw new Error("currentPrimaryReportingLine produced no condition");
  return condition;
}

export function reportingLineOfEmployment(
  orgId: string,
  employments: EmploymentsTable = hrEmployments,
  lines: ReportingLinesTable = hrReportingLines,
): SQL {
  const condition = and(
    currentPrimaryReportingLine(orgId, lines),
    eq(lines.employmentId, employments.id),
  );
  if (!condition)
    throw new Error("reportingLineOfEmployment produced no condition");
  return condition;
}

export function managerEmploymentOfLine(
  orgId: string,
  lines: ReportingLinesTable,
  managerEmployments: EmploymentsTable,
): SQL {
  const condition = and(
    eq(managerEmployments.orgId, orgId),
    eq(managerEmployments.id, lines.managerEmploymentId),
    isNull(managerEmployments.deletedAt),
  );
  if (!condition)
    throw new Error("managerEmploymentOfLine produced no condition");
  return condition;
}

export function orgUnitInOrg(
  orgId: string,
  unitId: PgColumn,
  units: OrgUnitsTable = orgUnits,
): SQL {
  const condition = and(eq(units.orgId, orgId), eq(units.id, unitId));
  if (!condition) throw new Error("orgUnitInOrg produced no condition");
  return condition;
}

const standingManagerEmployment = alias(hrEmployments, "standing_manager_employment");
const standingManagerPerson = alias(hrPeople, "standing_manager_person");
const standingReportEmployment = alias(hrEmployments, "standing_report_employment");

export async function hasCurrentDirectReport(
  db: Db | TenantTx,
  orgId: string,
  managerUserId: string,
): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(hrReportingLines)
    .innerJoin(
      standingManagerEmployment,
      managerEmploymentOfLine(orgId, hrReportingLines, standingManagerEmployment),
    )
    .innerJoin(
      standingManagerPerson,
      livePersonOfEmployment(orgId, standingManagerEmployment, standingManagerPerson),
    )
    .innerJoin(
      standingReportEmployment,
      and(
        liveEmployment(orgId, standingReportEmployment),
        eq(standingReportEmployment.id, hrReportingLines.employmentId),
      ),
    )
    .where(
      and(
        currentPrimaryReportingLine(orgId),
        eq(standingManagerPerson.userId, managerUserId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
