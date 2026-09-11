import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  auditLogs,
  hrDataRequests,
  hrEmployments,
  hrLegalHolds,
  hrPeople,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

export const SYNC_EXPORT_CAP = 500;

export interface SubjectExportResult {
  exportedAt: string;
  subject: {
    userId: string;
    email: string;
    name: string | null;
  };
  memberships: Array<{
    orgId: string;
    role: string;
    status: string;
    joinedAt: Date | null;
  }>;
  employment: Array<{
    orgId: string;
    lifecycleStatus: string;
    departmentId: string | null;
    designation: string | null;
    joiningDate: string | null;
    lastWorkingDay: string | null;
  }>;
  dataRequests: Array<{
    id: number;
    orgId: string;
    type: string;
    status: string;
    reason: string | null;
    createdAt: Date;
  }>;
  legalHolds: Array<{
    id: number;
    orgId: string;
    reason: string;
    status: string;
    placedAt: Date;
    releasedAt: Date | null;
  }>;
  auditEntries: Array<{
    id: number;
    action: string;
    targetId: string | null;
    targetType: string | null;
    actorUserId: string | null;
    resourceType: string | null;
    resourceId: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  }>;
  auditEntriesPresent: boolean;
  exportIncomplete: string[];
}

export async function fetchSyncEmployment(
  db: Db,
  subjectUserId: string,
  callerOrgId: string,
  exportIncomplete: string[],
): Promise<SubjectExportResult["employment"]> {
  const hrPersonRowsRaw = await db
    .select({
      orgId: hrPeople.orgId,
      hrPersonId: hrPeople.id,
    })
    .from(hrPeople)
    .where(
      and(
        eq(hrPeople.userId, subjectUserId),
        eq(hrPeople.orgId, callerOrgId),
        isNull(hrPeople.deletedAt),
      ),
    )
    .limit(SYNC_EXPORT_CAP + 1);
  if (hrPersonRowsRaw.length > SYNC_EXPORT_CAP)
    exportIncomplete.push(`hr_people: truncated at ${SYNC_EXPORT_CAP} records — use async export for full extract`);
  const hrPersonRows = hrPersonRowsRaw.slice(0, SYNC_EXPORT_CAP);

  const employment: SubjectExportResult["employment"] = [];
  if (hrPersonRows.length === 0) return employment;

  const ranked = db
    .select({
      personId: hrEmployments.personId,
      orgId: hrPeople.orgId,
      lifecycleStatus: hrEmployments.lifecycleStatus,
      departmentId: hrEmployments.departmentId,
      designation: hrEmployments.designation,
      joiningDate: hrEmployments.joiningDate,
      lastWorkingDay: hrEmployments.lastWorkingDay,
      personRank: sql<number>`row_number() over (partition by ${hrEmployments.personId} order by ${hrEmployments.id})`.as(
        "person_rank",
      ),
    })
    .from(hrEmployments)
    .innerJoin(hrPeople, eq(hrEmployments.personId, hrPeople.id))
    .where(
      and(
        inArray(
          hrEmployments.personId,
          hrPersonRows.map((person) => person.hrPersonId),
        ),
        eq(hrPeople.orgId, callerOrgId),
        isNull(hrEmployments.deletedAt),
      ),
    )
    .as("ranked_employments");

  const rankedRows = await db
    .select()
    .from(ranked)
    .where(lte(ranked.personRank, SYNC_EXPORT_CAP + 1))
    .limit(hrPersonRows.length * (SYNC_EXPORT_CAP + 1));

  const byPerson = new Map<number, typeof rankedRows>();
  for (const row of rankedRows) {
    const rows = byPerson.get(row.personId) ?? [];
    rows.push(row);
    byPerson.set(row.personId, rows);
  }

  for (const person of hrPersonRows) {
    const rows = byPerson.get(person.hrPersonId) ?? [];
    if (rows.length > SYNC_EXPORT_CAP)
      exportIncomplete.push(`hr_employments: truncated at ${SYNC_EXPORT_CAP} records for person ${person.hrPersonId} — use async export for full extract`);
    for (const r of rows.slice(0, SYNC_EXPORT_CAP))
      employment.push({
        orgId: r.orgId,
        lifecycleStatus: r.lifecycleStatus,
        departmentId: r.departmentId ?? null,
        designation: r.designation ?? null,
        joiningDate: r.joiningDate ?? null,
        lastWorkingDay: r.lastWorkingDay ?? null,
      });
  }

  return employment;
}

export async function fetchSyncDataRequests(
  db: Db,
  subjectUserId: string,
  callerOrgId: string,
  exportIncomplete: string[],
) {
  const dataRequestsRaw = await db
    .select({
      id: hrDataRequests.id,
      orgId: hrDataRequests.orgId,
      type: hrDataRequests.type,
      status: hrDataRequests.status,
      reason: hrDataRequests.reason,
      createdAt: hrDataRequests.createdAt,
    })
    .from(hrDataRequests)
    .where(
      and(
        eq(hrDataRequests.subjectUserId, subjectUserId),
        eq(hrDataRequests.orgId, callerOrgId),
        isNull(hrDataRequests.deletedAt),
      ),
    )
    .limit(SYNC_EXPORT_CAP + 1);
  if (dataRequestsRaw.length > SYNC_EXPORT_CAP)
    exportIncomplete.push(`hr_data_requests: truncated at ${SYNC_EXPORT_CAP} records — use async export for full extract`);
  return dataRequestsRaw.slice(0, SYNC_EXPORT_CAP);
}

export async function fetchSyncLegalHolds(
  db: Db,
  subjectUserId: string,
  callerOrgId: string,
  exportIncomplete: string[],
) {
  const legalHoldsRaw = await db
    .select({
      id: hrLegalHolds.id,
      orgId: hrLegalHolds.orgId,
      reason: hrLegalHolds.reason,
      status: hrLegalHolds.status,
      placedAt: hrLegalHolds.placedAt,
      releasedAt: hrLegalHolds.releasedAt,
    })
    .from(hrLegalHolds)
    .where(
      and(
        eq(hrLegalHolds.subjectUserId, subjectUserId),
        eq(hrLegalHolds.orgId, callerOrgId),
        isNull(hrLegalHolds.deletedAt),
      ),
    )
    .limit(SYNC_EXPORT_CAP + 1);
  if (legalHoldsRaw.length > SYNC_EXPORT_CAP)
    exportIncomplete.push(`hr_legal_holds: truncated at ${SYNC_EXPORT_CAP} records — use async export for full extract`);
  return legalHoldsRaw.slice(0, SYNC_EXPORT_CAP);
}

export async function fetchSyncAuditEntries(
  db: Db,
  subjectUserId: string,
  callerOrgId: string,
  exportIncomplete: string[],
) {
  const auditEntriesRaw = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      targetId: auditLogs.targetId,
      targetType: auditLogs.targetType,
      actorUserId: auditLogs.actorUserId,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.userId, subjectUserId), eq(auditLogs.orgId, callerOrgId)))
    .limit(SYNC_EXPORT_CAP + 1);
  if (auditEntriesRaw.length > SYNC_EXPORT_CAP)
    exportIncomplete.push(`audit_logs: truncated at ${SYNC_EXPORT_CAP} records — use async export for full extract`);
  return auditEntriesRaw.slice(0, SYNC_EXPORT_CAP);
}
