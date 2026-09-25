import { and, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { hrEmployments, hrPeople, organizationMembers } from "../db/schema";
import type { DbOrTx } from "../common/rbac/access-invalidate";
import { writePrimaryLines, type LineProvenance } from "../common/hr/sync-canonical-reporting-line";

/**
 * TEST SEEDING ONLY. A user-id front door onto `writePrimaryLines` that skips every relationship rule
 * (eligibility, cycles, the frequency guard, audit). Production writes go through
 * `ReportingRelationshipService.setRelationships`; this lives under src/test so nothing in src/modules
 * can reach past the validation (HRM-15 item 10).
 */

export type ReportingLineUnmappableReason =
  | "employment-missing"
  | "manager-not-in-organization"
  | "manager-has-no-employment"
  | "self-reference";

export type ReportingLineOutcome =
  | { status: "written"; employmentId: number; managerEmploymentId: number; lineId: number }
  | { status: "unchanged"; employmentId: number; managerEmploymentId: number; lineId: number }
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

export async function syncCanonicalReportingLine(
  db: DbOrTx,
  orgId: string,
  userId: string,
  managerUserId: string | null,
  effectiveFrom: string,
  createdBy: string | null,
  provenance?: Omit<LineProvenance, "createdBy">,
): Promise<ReportingLineOutcome> {
  const outcomes = await syncCanonicalReportingLines(db, orgId, [userId], managerUserId, effectiveFrom, createdBy, provenance);
  return outcomes.get(userId) ?? { status: "unmappable", reason: "employment-missing" };
}

/**
 * The user-id front door onto `writePrimaryLines` for callers that hold users, not employments.
 * `source` defaults to MANUAL: every caller that predates provenance is a person editing a record.
 */
export async function syncCanonicalReportingLines(
  db: DbOrTx,
  orgId: string,
  userIds: readonly string[],
  managerUserId: string | null,
  effectiveFrom: string,
  createdBy: string | null,
  provenance?: Omit<LineProvenance, "createdBy">,
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

  let manager: number | null = null;
  if (managerUserId !== null) {
    const resolved = await managerEmploymentIdOf(db, orgId, managerUserId);
    if (resolved === "not-a-member" || resolved === "no-employment") {
      const reason: ReportingLineUnmappableReason =
        resolved === "not-a-member" ? "manager-not-in-organization" : "manager-has-no-employment";
      for (const group of usersByEmployment.values())
        for (const userId of group) outcomes.set(userId, { status: "unmappable", reason });
      return outcomes;
    }
    manager = resolved;
  }

  const results = await writePrimaryLines(
    db,
    orgId,
    employmentIds.map((employmentId) => ({ employmentId, managerEmploymentId: manager })),
    { from: effectiveFrom },
    { source: "MANUAL", ...provenance, createdBy },
  );

  for (const [employmentId, group] of usersByEmployment) {
    const result = results.get(employmentId);
    for (const userId of group) {
      if (!result || result.status === "cleared") outcomes.set(userId, { status: "cleared", employmentId });
      else outcomes.set(userId, { status: result.status, employmentId, managerEmploymentId: result.managerEmploymentId, lineId: result.lineId });
    }
  }
  return outcomes;
}
