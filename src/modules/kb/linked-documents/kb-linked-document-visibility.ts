import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { documentAudiences, documents, hrEmployments, hrPeople, kbLinkedDocumentAudiences, kbLinkedDocuments } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";

const LIVE_EMPLOYMENT_STATUSES = ["ACTIVE", "PROBATION", "CONFIRMED", "NOTICE"] as const;

const MAX_LIVE_EMPLOYMENTS = 20;

export interface CallerAudience {
  isEmployee: boolean;
  departmentIds: readonly string[];
  locationIds: readonly string[];
}

const NOT_AN_EMPLOYEE: CallerAudience = { isEmployee: false, departmentIds: [], locationIds: [] };

export async function loadCallerAudience(
  reader: Pick<TenantTx, "select">,
  orgId: string,
  userId: string,
): Promise<CallerAudience> {
  const rows = await reader
    .select({ departmentId: hrEmployments.departmentId, locationId: hrEmployments.locationId })
    .from(hrEmployments)
    .innerJoin(hrPeople, and(eq(hrPeople.orgId, hrEmployments.orgId), eq(hrPeople.id, hrEmployments.personId)))
    .where(
      and(
        eq(hrEmployments.orgId, orgId),
        eq(hrPeople.userId, userId),
        isNull(hrPeople.deletedAt),
        isNull(hrPeople.archivedAt),
        isNull(hrEmployments.deletedAt),
        isNull(hrEmployments.archivedAt),
        inArray(hrEmployments.lifecycleStatus, LIVE_EMPLOYMENT_STATUSES),
      ),
    )
    .limit(MAX_LIVE_EMPLOYMENTS);
  if (rows.length === 0) return NOT_AN_EMPLOYEE;
  const departmentIds = new Set<string>();
  const locationIds = new Set<string>();
  for (const row of rows) {
    if (row.departmentId !== null) departmentIds.add(row.departmentId);
    if (row.locationId !== null) locationIds.add(row.locationId);
  }
  return { isEmployee: true, departmentIds: [...departmentIds], locationIds: [...locationIds] };
}

const linkIsLive: SQL = sql`(${kbLinkedDocuments.status} = 'active' AND ${kbLinkedDocuments.documentId} IS NOT NULL AND app.hr_document_is_publishable(${documents}))`;

function callerInAudience(caller: CallerAudience): SQL {
  const arms: SQL[] = [];
  if (caller.isEmployee) arms.push(sql`a.kind = 'ALL_EMPLOYEES'`);
  if (caller.departmentIds.length > 0)
    arms.push(sql`(a.kind = 'DEPARTMENT' AND a.ref_id IN (${sql.join(caller.departmentIds.map((id) => sql`${id}`), sql`, `)}))`);
  if (caller.locationIds.length > 0)
    arms.push(sql`(a.kind = 'LOCATION' AND a.ref_id IN (${sql.join(caller.locationIds.map((id) => sql`${id}`), sql`, `)}))`);
  if (arms.length === 0) return sql`false`;
  return sql`EXISTS (
    SELECT 1 FROM ${kbLinkedDocumentAudiences} AS a
    WHERE a.org_id = ${kbLinkedDocuments.orgId}
      AND a.linked_document_id = ${kbLinkedDocuments.id}
      AND (${sql.join(arms, sql` OR `)})
      AND EXISTS (
        SELECT 1 FROM ${documentAudiences} AS c
        WHERE c.org_id = a.org_id
          AND c.document_id = ${kbLinkedDocuments.documentId}
          AND (c.kind = 'ALL_EMPLOYEES' OR (c.kind = a.kind AND coalesce(c.ref_id, '') = coalesce(a.ref_id, '')))
      )
  )`;
}

export const publisherCanSeeRecord: SQL = sql`(${kbLinkedDocuments.status} <> 'active' OR ${linkIsLive})`;

export function visibleTo(caller: CallerAudience, canPublish: boolean): SQL {
  return canPublish ? linkIsLive : sql`(${linkIsLive} AND ${callerInAudience(caller)})`;
}
