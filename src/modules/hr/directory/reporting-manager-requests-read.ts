import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { decodeTupleCursor, encodeTupleCursor } from "../../../common/pagination/cursor";
import { hrEmployments, hrPeople, hrReportingManagerRequests } from "../../../db/schema";
import type { ScopedRead } from "../../access/scoped-read";
import { relationshipsBetween } from "../../directory/reporting-line-queries";
import { peopleByEmploymentIds, type PersonRef } from "./reporting-manager-people";
import type { ManagerRef } from "./dto/reporting-lines-shared.schemas";
import type {
  HrReportingManagerRequest,
  MyReportingManagerRequest,
  ReportingManagerRequestStatus,
} from "./dto/reporting-lines-requests.schemas";

export const requestFields = {
  id: hrReportingManagerRequests.id,
  employeeEmploymentId: hrReportingManagerRequests.employeeEmploymentId,
  employeeUserId: hrPeople.userId,
  requestedByUserId: hrReportingManagerRequests.requestedByUserId,
  currentPrimaryLineId: hrReportingManagerRequests.currentPrimaryLineId,
  suggestedManagerEmploymentId: hrReportingManagerRequests.suggestedManagerEmploymentId,
  requestedEffectiveFrom: hrReportingManagerRequests.requestedEffectiveFrom,
  employeeReason: hrReportingManagerRequests.employeeReason,
  status: hrReportingManagerRequests.status,
  reviewerUserId: hrReportingManagerRequests.reviewerUserId,
  reviewReason: hrReportingManagerRequests.reviewReason,
  createdAt: hrReportingManagerRequests.createdAt,
  updatedAt: hrReportingManagerRequests.updatedAt,
  resolvedAt: hrReportingManagerRequests.resolvedAt,
  cursorAt: sql<string>`to_char(${hrReportingManagerRequests.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
};

export interface RequestRow {
  id: string;
  employeeEmploymentId: number;
  employeeUserId: string | null;
  requestedByUserId: string;
  currentPrimaryLineId: number | null;
  suggestedManagerEmploymentId: number | null;
  requestedEffectiveFrom: string | null;
  employeeReason: string;
  status: ReportingManagerRequestStatus;
  reviewerUserId: string | null;
  reviewReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  cursorAt: string;
}

/** Requests joined to the employee's person, so the scope predicate can name the employee's user. */
export function requestsFrom(db: DbOrTx, orgId: string) {
  return db
    .select(requestFields)
    .from(hrReportingManagerRequests)
    .innerJoin(
      hrEmployments,
      and(eq(hrEmployments.orgId, orgId), eq(hrEmployments.id, hrReportingManagerRequests.employeeEmploymentId)),
    )
    .innerJoin(hrPeople, and(eq(hrPeople.orgId, orgId), eq(hrPeople.id, hrEmployments.personId)));
}

export const liveRequest = isNull(hrReportingManagerRequests.deletedAt);

/** Newest first, `(created_at, id)` at microsecond precision so no row falls between pages. */
export function requestCursorBefore(cursor: string | undefined): SQL | undefined {
  const parts = decodeTupleCursor(cursor, 2);
  if (!parts) return undefined;
  const [at, id] = parts;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(at ?? "") || !/^[0-9a-f-]{36}$/i.test(id ?? "")) return undefined;
  return sql`(${hrReportingManagerRequests.createdAt}, ${hrReportingManagerRequests.id}) < ((${at}::timestamp AT TIME ZONE 'UTC'), ${id}::uuid)`;
}

export const requestOrder = [desc(hrReportingManagerRequests.createdAt), desc(hrReportingManagerRequests.id)];

export function requestPage<T>(rows: readonly RequestRow[], limit: number, map: (rows: RequestRow[]) => Promise<T[]>) {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return map(page).then((items) => ({
    items,
    nextCursor: rows.length > limit && last ? encodeTupleCursor([last.cursorAt, last.id]) : null,
  }));
}

function refOf(person: PersonRef | undefined): ManagerRef | null {
  if (!person) return null;
  return { userId: person.userId, name: person.name, email: person.email, designation: person.designation, state: person.state };
}

export async function toMyRequests(db: DbOrTx, orgId: string, rows: readonly RequestRow[]): Promise<MyReportingManagerRequest[]> {
  const suggested = await peopleByEmploymentIds(
    db,
    orgId,
    rows.flatMap((row) => (row.suggestedManagerEmploymentId === null ? [] : [row.suggestedManagerEmploymentId])),
  );
  return rows.map((row) => ({
    requestId: row.id,
    status: row.status,
    employeeReason: row.employeeReason,
    suggestedManager: row.suggestedManagerEmploymentId === null ? null : refOf(suggested.get(row.suggestedManagerEmploymentId)),
    requestedEffectiveFrom: row.requestedEffectiveFrom,
    reviewReason: row.reviewReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  }));
}

/** HR's view adds the employee and whoever is their primary manager today. */
export async function toHrRequests(
  db: DbOrTx,
  orgId: string,
  today: string,
  rows: readonly RequestRow[],
): Promise<HrReportingManagerRequest[]> {
  const employmentIds = rows.map((row) => row.employeeEmploymentId);
  const current = (await relationshipsBetween(db, orgId, employmentIds, today, today)).filter((line) => line.primary);
  const managerOf = new Map(current.map((line) => [line.employmentId, line.managerEmploymentId]));
  const [mine, people] = await Promise.all([
    toMyRequests(db, orgId, rows),
    peopleByEmploymentIds(db, orgId, [...employmentIds, ...current.map((line) => line.managerEmploymentId)]),
  ]);
  return rows.map((row, index) => {
    const managerEmploymentId = managerOf.get(row.employeeEmploymentId);
    const base = mine[index];
    const employee = refOf(people.get(row.employeeEmploymentId));
    return {
      ...base,
      employee: employee ?? { userId: row.employeeUserId ?? "", name: "Unknown employee", email: null, designation: null, state: "inactive" },
      currentManager: managerEmploymentId === undefined ? null : refOf(people.get(managerEmploymentId)),
    };
  });
}

/** The HR queue's scope: the reader's employees scope, applied to the request's employee. */
export function scopedRequests(read: ScopedRead, db: DbOrTx, where: SQL[], limit: number): Promise<RequestRow[]> {
  return read.read(
    {
      tenant: hrReportingManagerRequests.orgId,
      scope: { columns: { ownerColumn: hrPeople.userId } },
      and: [liveRequest, ...where],
    },
    ({ sql: scoped }) => requestsFrom(db, read.orgId).where(scoped).orderBy(...requestOrder).limit(limit),
    () => [],
  );
}
