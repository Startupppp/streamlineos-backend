import { and, asc, eq, getTableColumns, gt, isNull } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import {
  collectSubjectFileKeysWithLegalHold,
  enumerateFileKeyColumns,
} from "../storage/storage-key-catalog";
import {
  BATCH_SIZE,
  REDACTED_EXPORT_COLUMNS,
  type ExportCursor,
  type SubjectScopedTable,
} from "./gdpr-export-types";

export async function fetchSubjectFileKeys(
  db: Db,
  orgId: string,
  subjectUserId: string,
) {
  const columns = await enumerateFileKeyColumns(db);
  return collectSubjectFileKeysWithLegalHold(db, subjectUserId, [orgId], columns);
}

export async function fetchSubjectScopedRows(
  db: Db,
  table: SubjectScopedTable,
  userColumn: AnyColumn,
  orgId: string,
  subjectUserId: string,
  afterId: ExportCursor | undefined,
): Promise<Array<{ id: ExportCursor } & Record<string, unknown>>> {
  const selectedColumns = Object.fromEntries(
    Object.entries(getTableColumns(table)).filter(
      ([name]) => !REDACTED_EXPORT_COLUMNS.has(name),
    ),
  );
  const conditions = [eq(table.orgId, orgId), eq(userColumn, subjectUserId)];
  if (afterId !== undefined) conditions.push(gt(table.id, afterId));
  const rows = await db
    .select(selectedColumns)
    .from(table)
    .where(and(...conditions))
    .orderBy(asc(table.id))
    .limit(BATCH_SIZE);
  return rows as Array<{ id: ExportCursor } & Record<string, unknown>>;
}

export async function fetchMembershipScopedRows(
  db: Db,
  table: SubjectScopedTable,
  membershipColumn: AnyColumn,
  orgId: string,
  subjectUserId: string,
  afterId: ExportCursor | undefined,
): Promise<Array<{ id: ExportCursor } & Record<string, unknown>>> {
  const selectedColumns = Object.fromEntries(
    Object.entries(getTableColumns(table)).filter(
      ([name]) => !REDACTED_EXPORT_COLUMNS.has(name),
    ),
  );
  const conditions = [
    eq(table.orgId, orgId),
    eq(organizationMembers.orgId, orgId),
    eq(organizationMembers.userId, subjectUserId),
  ];
  if (afterId !== undefined) conditions.push(gt(table.id, afterId));
  const rows = await db
    .select(selectedColumns)
    .from(table)
    .innerJoin(
      organizationMembers,
      and(
        eq(table.orgId, organizationMembers.orgId),
        eq(membershipColumn, organizationMembers.id),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(table.id))
    .limit(BATCH_SIZE);
  return rows as Array<{ id: ExportCursor } & Record<string, unknown>>;
}

export async function fetchEmploymentScopedRows(
  db: Db,
  table: SubjectScopedTable,
  employmentColumn: AnyColumn,
  orgId: string,
  subjectUserId: string,
  afterId: ExportCursor | undefined,
): Promise<Array<{ id: ExportCursor } & Record<string, unknown>>> {
  const selectedColumns = Object.fromEntries(
    Object.entries(getTableColumns(table)).filter(
      ([name]) => !REDACTED_EXPORT_COLUMNS.has(name),
    ),
  );
  const conditions = [
    eq(table.orgId, orgId),
    eq(hrEmployments.orgId, orgId),
    eq(hrPeople.orgId, orgId),
    eq(hrPeople.userId, subjectUserId),
  ];
  if (afterId !== undefined) conditions.push(gt(table.id, afterId));
  const rows = await db
    .select(selectedColumns)
    .from(table)
    .innerJoin(
      hrEmployments,
      and(
        eq(table.orgId, hrEmployments.orgId),
        eq(employmentColumn, hrEmployments.id),
      ),
    )
    .innerJoin(
      hrPeople,
      and(
        eq(hrEmployments.orgId, hrPeople.orgId),
        eq(hrEmployments.personId, hrPeople.id),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(table.id))
    .limit(BATCH_SIZE);
  return rows as Array<{ id: ExportCursor } & Record<string, unknown>>;
}
