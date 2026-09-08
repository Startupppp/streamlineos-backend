import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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

async function primaryEmploymentIdsOf(
  db: DbOrTx,
  orgId: string,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  const rows = await db
    .select({ userId: hrPeople.userId, employmentId: hrEmployments.id })
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
        inArray(hrPeople.userId, [...userIds]),
        isNull(hrPeople.deletedAt),
      ),
    );

  const byUser = new Map<string, number>();
  for (const row of rows)
    if (row.userId !== null && !byUser.has(row.userId))
      byUser.set(row.userId, row.employmentId);
  return byUser;
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

function openPrimaryLinesOf(orgId: string, employmentIds: readonly number[]) {
  return and(
    eq(hrReportingLines.orgId, orgId),
    inArray(hrReportingLines.employmentId, [...employmentIds]),
    eq(hrReportingLines.lineType, "primary"),
    sql`${hrReportingLines.effectiveTo} = 'infinity'::date`,
  );
}

export async function syncCanonicalReportingLine(
  db: DbOrTx,
  orgId: string,
  userId: string,
  managerUserId: string | null,
  effectiveFrom: string,
  createdBy: string | null,
): Promise<ReportingLineOutcome> {
  const outcomes = await syncCanonicalReportingLines(
    db,
    orgId,
    [userId],
    managerUserId,
    effectiveFrom,
    createdBy,
  );
  return outcomes.get(userId) ?? { status: "unmappable", reason: "employment-missing" };
}

/** The same sync for many reportees that share one manager — six statements for any count. */
export async function syncCanonicalReportingLines(
  db: DbOrTx,
  orgId: string,
  userIds: readonly string[],
  managerUserId: string | null,
  effectiveFrom: string,
  createdBy: string | null,
): Promise<Map<string, ReportingLineOutcome>> {
  const outcomes = new Map<string, ReportingLineOutcome>();
  const subjects = [...new Set(userIds)];
  if (subjects.length === 0) return outcomes;

  const employmentByUser = await primaryEmploymentIdsOf(db, orgId, subjects);

  const usersByEmployment = new Map<number, string[]>();
  for (const userId of subjects) {
    const employmentId = employmentByUser.get(userId);
    if (employmentId === undefined) {
      outcomes.set(userId, { status: "unmappable", reason: "employment-missing" });
      continue;
    }
    if (userId === managerUserId) {
      outcomes.set(userId, { status: "unmappable", reason: "self-reference" });
      continue;
    }
    const group = usersByEmployment.get(employmentId);
    if (group) group.push(userId);
    else usersByEmployment.set(employmentId, [userId]);
  }

  const employmentIds = [...usersByEmployment.keys()];
  if (employmentIds.length === 0) return outcomes;

  if (managerUserId === null) {
    await db
      .update(hrReportingLines)
      .set({ effectiveTo: dayBefore(effectiveFrom) })
      .where(openPrimaryLinesOf(orgId, employmentIds));
    for (const [employmentId, group] of usersByEmployment)
      for (const userId of group) outcomes.set(userId, { status: "cleared", employmentId });
    return outcomes;
  }

  const manager = await managerEmploymentIdOf(db, orgId, managerUserId);
  if (manager === "not-a-member" || manager === "no-employment") {
    const reason: ReportingLineUnmappableReason =
      manager === "not-a-member" ? "manager-not-in-organization" : "manager-has-no-employment";
    for (const group of usersByEmployment.values())
      for (const userId of group) outcomes.set(userId, { status: "unmappable", reason });
    return outcomes;
  }

  const openLines = await db
    .select({
      id: hrReportingLines.id,
      employmentId: hrReportingLines.employmentId,
      managerEmploymentId: hrReportingLines.managerEmploymentId,
    })
    .from(hrReportingLines)
    .where(openPrimaryLinesOf(orgId, employmentIds));

  const openByEmployment = new Map<number, { id: number; managerEmploymentId: number }>();
  for (const line of openLines)
    if (!openByEmployment.has(line.employmentId))
      openByEmployment.set(line.employmentId, {
        id: line.id,
        managerEmploymentId: line.managerEmploymentId,
      });

  const lineIdsToClose: number[] = [];
  const newLines: Array<{
    orgId: string;
    employmentId: number;
    managerEmploymentId: number;
    lineType: "primary";
    effectiveFrom: string;
    createdBy: string | null;
  }> = [];

  for (const [employmentId, group] of usersByEmployment) {
    const existing = openByEmployment.get(employmentId);
    if (existing?.managerEmploymentId === manager) {
      for (const userId of group)
        outcomes.set(userId, { status: "unchanged", employmentId, managerEmploymentId: manager });
      continue;
    }
    if (existing) lineIdsToClose.push(existing.id);
    newLines.push({
      orgId,
      employmentId,
      managerEmploymentId: manager,
      lineType: "primary",
      effectiveFrom,
      createdBy,
    });
    for (const userId of group)
      outcomes.set(userId, { status: "written", employmentId, managerEmploymentId: manager });
  }

  if (lineIdsToClose.length > 0)
    await db
      .update(hrReportingLines)
      .set({ effectiveTo: dayBefore(effectiveFrom) })
      .where(
        and(
          eq(hrReportingLines.orgId, orgId),
          inArray(hrReportingLines.id, lineIdsToClose),
        ),
      );

  if (newLines.length > 0) await db.insert(hrReportingLines).values(newLines);

  return outcomes;
}
