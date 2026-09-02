import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  hrEmployments,
  hrPeople,
  hrReportingLines,
  organizationMembers,
} from "../../db/schema";
import type { DbOrTx } from "../rbac/access-invalidate";

export type ReportingLineUnmappableReason =
  | "employment-missing"
  | "manager-not-in-organization"
  | "manager-has-no-employment"
  | "self-reference";

export type ReportingLineOutcome =
  | { status: "written"; employmentId: number; managerEmploymentId: number }
  | { status: "unchanged"; employmentId: number; managerEmploymentId: number }
  | { status: "cleared"; employmentId: number }
  | { status: "unmappable"; reason: ReportingLineUnmappableReason };

const managerEmployments = alias(hrEmployments, "manager_employment");
const managerPeople = alias(hrPeople, "manager_person");

async function primaryEmploymentIdOf(
  db: DbOrTx,
  orgId: string,
  userId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ id: hrEmployments.id })
    .from(hrEmployments)
    .innerJoin(
      hrPeople,
      and(eq(hrPeople.id, hrEmployments.personId), eq(hrPeople.orgId, hrEmployments.orgId)),
    )
    .where(
      and(
        eq(hrEmployments.orgId, orgId),
        eq(hrEmployments.isPrimary, true),
        isNull(hrEmployments.deletedAt),
        eq(hrPeople.userId, userId),
        isNull(hrPeople.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function managerEmploymentIdOf(
  db: DbOrTx,
  orgId: string,
  managerUserId: string,
): Promise<number | "not-a-member" | "no-employment"> {
  const [membership] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, managerUserId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    )
    .limit(1);
  if (!membership) return "not-a-member";

  const [row] = await db
    .select({ id: managerEmployments.id })
    .from(managerEmployments)
    .innerJoin(
      managerPeople,
      and(
        eq(managerPeople.id, managerEmployments.personId),
        eq(managerPeople.orgId, managerEmployments.orgId),
      ),
    )
    .where(
      and(
        eq(managerEmployments.orgId, orgId),
        eq(managerEmployments.isPrimary, true),
        isNull(managerEmployments.deletedAt),
        eq(managerPeople.userId, managerUserId),
        isNull(managerPeople.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? "no-employment";
}

function dayBefore(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return previous.toISOString().slice(0, 10);
}

export async function syncCanonicalReportingLine(
  db: DbOrTx,
  orgId: string,
  userId: string,
  managerUserId: string | null,
  effectiveFrom: string,
  createdBy: string | null,
): Promise<ReportingLineOutcome> {
  const employmentId = await primaryEmploymentIdOf(db, orgId, userId);
  if (employmentId === null) return { status: "unmappable", reason: "employment-missing" };

  const openLine = and(
    eq(hrReportingLines.orgId, orgId),
    eq(hrReportingLines.employmentId, employmentId),
    eq(hrReportingLines.lineType, "primary"),
    sql`${hrReportingLines.effectiveTo} = 'infinity'::date`,
  );

  if (managerUserId === null) {
    await db
      .update(hrReportingLines)
      .set({ effectiveTo: dayBefore(effectiveFrom) })
      .where(openLine);
    return { status: "cleared", employmentId };
  }

  if (managerUserId === userId) return { status: "unmappable", reason: "self-reference" };

  const manager = await managerEmploymentIdOf(db, orgId, managerUserId);
  if (manager === "not-a-member")
    return { status: "unmappable", reason: "manager-not-in-organization" };
  if (manager === "no-employment")
    return { status: "unmappable", reason: "manager-has-no-employment" };

  const [existing] = await db
    .select({
      id: hrReportingLines.id,
      managerEmploymentId: hrReportingLines.managerEmploymentId,
    })
    .from(hrReportingLines)
    .where(openLine)
    .limit(1);

  if (existing?.managerEmploymentId === manager)
    return { status: "unchanged", employmentId, managerEmploymentId: manager };

  if (existing)
    await db
      .update(hrReportingLines)
      .set({ effectiveTo: dayBefore(effectiveFrom) })
      .where(and(eq(hrReportingLines.id, existing.id), eq(hrReportingLines.orgId, orgId)));

  await db.insert(hrReportingLines).values({
    orgId,
    employmentId,
    managerEmploymentId: manager,
    lineType: "primary",
    effectiveFrom,
    createdBy,
  });

  return { status: "written", employmentId, managerEmploymentId: manager };
}

async function currentManagerEmploymentId(
  db: DbOrTx,
  orgId: string,
  employmentId: number,
  onDate: string,
): Promise<number | null> {
  const [row] = await db
    .select({ managerEmploymentId: hrReportingLines.managerEmploymentId })
    .from(hrReportingLines)
    .where(
      and(
        eq(hrReportingLines.orgId, orgId),
        eq(hrReportingLines.employmentId, employmentId),
        eq(hrReportingLines.lineType, "primary"),
        sql`${hrReportingLines.effectiveFrom} <= ${onDate}::date`,
        sql`${hrReportingLines.effectiveTo} >= ${onDate}::date`,
        ne(hrReportingLines.managerEmploymentId, employmentId),
      ),
    )
    .limit(1);
  return row?.managerEmploymentId ?? null;
}
