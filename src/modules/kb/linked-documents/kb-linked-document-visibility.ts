import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { documentAudiences, documents, hrEmployments, hrPeople, kbLinkedDocumentAudiences, kbLinkedDocuments } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";

/** Employment states in which someone is an employee for the purpose of "all employees". Onboarding and exited people are not. */
const LIVE_EMPLOYMENT_STATUSES = ["ACTIVE", "PROBATION", "CONFIRMED", "NOTICE"] as const;

// A person can hold a handful of concurrent employments; more than this is a data problem, not a reason to read on.
const MAX_LIVE_EMPLOYMENTS = 20;

/** What decides which entries a caller may see. Derived from the caller's live employment, never from a request. */
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

/**
 * The read-time guard, and the reason a stale link cannot leak: an entry is live only while it is active AND
 * its document is still publishable right now, judged by the SAME database function that stops a write
 * (`app.hr_document_is_publishable`, migration 1201). Whatever a document has become since it was linked, a
 * reader cannot see it through the link. Needs `documents` joined into the query.
 */
const linkIsLive: SQL = sql`(${kbLinkedDocuments.status} = 'active' AND ${kbLinkedDocuments.documentId} IS NOT NULL AND app.hr_document_is_publishable(${documents}))`;

/**
 * Is this caller inside one of the entry's audiences? An audience row counts only while the DOCUMENT's own
 * audiences still cover it, so narrowing a document takes effect on the next request even if the entry's own
 * rows were never rewritten. `ALL_EMPLOYEES` means an employee, not every member of the organisation.
 * Nobody is "in" an entry with no audience: it is visible to publishers only.
 */
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

/**
 * A publisher may see the RECORD of an entry that is no longer live (unpublished, source removed) to manage it,
 * but an entry that still says `active` is shown only while its document really is publishable: a stale
 * `active` over a personal document must not be readable by anyone, publishers included.
 */
export const publisherCanSeeRecord: SQL = sql`(${kbLinkedDocuments.status} <> 'active' OR ${linkIsLive})`;

/** What a caller may see: every live entry for a publisher, the live entries they are in the audience of for anyone else. */
export function visibleTo(caller: CallerAudience, canPublish: boolean): SQL {
  return canPublish ? linkIsLive : sql`(${linkIsLive} AND ${callerInAudience(caller)})`;
}
