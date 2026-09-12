import { ISSUE_RECORD_TYPES, type IssueRecordType } from "../../db/schema/crm/issue-records";
import {
  DECLARATIONS,
  FIELD,
  PLATFORM_FIELDS,
  RECORD_SECTION,
  type IssueColumnSpec,
  type IssueFieldName,
  type IssueFieldSpec,
  type IssueSectionSpec,
} from "./lib/issue-field-declarations";

export {
  ISSUE_FIELD_NAMES,
  type IssueColumnSpec,
  type IssueFieldName,
  type IssueFieldOption,
  type IssueFieldSpec,
  type IssueSectionSpec,
} from "./lib/issue-field-declarations";

/**
 * The three record types, as descriptions.
 *
 * The renderer takes its layout as data — `RecordLayout` in
 * `frontend/lib/renderer/layout.ts` — and `subject-layout.ts` already proves
 * what that buys: a field declaration becomes a list, a detail view and a form
 * with no branch anywhere asking what kind of record it is. Issues, tasks and
 * complaints are that same arrangement with the declaration held by the platform
 * instead of by a tenant, which is the entire content of criterion 1. Nothing in
 * this module renders anything; it serves the description and rows keyed to
 * match it.
 *
 * The declaration and the projection are generated from ONE map — `FIELD` in
 * `lib/issue-field-declarations.ts`, which holds the table this file reads — and
 * the types are what enforce it: a field that exists in a layout but not in
 * `issueRecordRow` fails to compile, and so does the reverse. That matters
 * because the failure mode here is silent — a column whose name the row does not
 * carry renders as an empty cell, on every row, forever.
 *
 * This file is the accessor half: it turns that table into the three layouts and
 * projects a row to match them. The table itself is data and sits next door.
 */

/** Mirrors the renderer's `RecordLayout`. */
export interface IssueRecordLayout {
  readonly key: string;
  readonly recordType: IssueRecordType;
  readonly singular: string;
  readonly plural: string;
  readonly titleField: string;
  readonly fields: readonly IssueFieldSpec[];
  readonly list: {
    readonly columns: readonly IssueColumnSpec[];
    readonly searchPlaceholder: string;
  };
  readonly detail: { readonly sections: readonly IssueSectionSpec[] };
  readonly form: { readonly sections: readonly IssueSectionSpec[] };
}

const SECTION_SIZE = 5;

function sectionsOf(
  names: readonly IssueFieldName[],
  singular: string,
  fields: Readonly<Record<IssueFieldName, IssueFieldSpec>>,
): IssueSectionSpec[] {
  const writable = names.filter((name) => !fields[name].readOnly);
  const sections: IssueSectionSpec[] = [];
  for (let index = 0; index < writable.length; index += SECTION_SIZE)
    sections.push({
      title: index === 0 ? singular : `${singular} (continued)`,
      fields: writable.slice(index, index + SECTION_SIZE),
    });
  return sections;
}

function layoutFor(recordType: IssueRecordType): IssueRecordLayout {
  const declaration = DECLARATIONS[recordType];
  const fields: Record<IssueFieldName, IssueFieldSpec> = { ...FIELD };
  for (const [name, patch] of Object.entries(declaration.overrides ?? {}))
    fields[name as IssueFieldName] = { ...fields[name as IssueFieldName], ...patch };

  const shown = [...declaration.declared, ...PLATFORM_FIELDS];
  const detailSections = sectionsOf(declaration.declared, declaration.singular, fields);

  return {
    key: `issue:${recordType}`,
    recordType,
    singular: declaration.singular,
    plural: declaration.plural,
    titleField: "title",
    fields: shown.map((name) => fields[name]),
    list: {
      searchPlaceholder: `Search ${declaration.plural.toLowerCase()}…`,
      columns: declaration.columns,
    },
    detail: { sections: [...detailSections, RECORD_SECTION] },
    form: { sections: detailSections },
  };
}

/**
 * The three descriptions, built once at module load.
 *
 * Served rather than compiled into the client for the reason `party-layout.ts`
 * records: descriptions belong in data, and the surface that reads one should
 * not care whether it came from a constant or a row.
 */
export const ISSUE_LAYOUTS: Readonly<Record<IssueRecordType, IssueRecordLayout>> =
  Object.fromEntries(
    ISSUE_RECORD_TYPES.map((recordType) => [recordType, layoutFor(recordType)]),
  ) as Record<IssueRecordType, IssueRecordLayout>;

/** The columns a read must project for a row to satisfy every declared field. */
export interface IssueRecordSource {
  readonly issueRecordId: string;
  readonly recordType: IssueRecordType;
  readonly title: string;
  readonly severity: string;
  readonly stage: string;
  readonly ownerUserId: string | null;
  readonly partyId: string | null;
  readonly partyName: string | null;
  readonly dealId: number | null;
  readonly dealTitle: string | null;
  readonly dueAt: Date | null;
  readonly openedAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly closedAt: Date | null;
  readonly details: string | null;
  readonly reference: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long this has been somebody's problem.
 *
 * Stops at `closedAt` rather than running forever, because the question a closed
 * record answers is "how long did it take", not "how long ago was it". Derived
 * here rather than in SQL so the projection stays typed columns.
 */
export function ageDays(row: Pick<IssueRecordSource, "openedAt" | "closedAt">, now: number): number {
  const end = row.closedAt ? row.closedAt.getTime() : now;
  return Math.max(0, Math.floor((end - row.openedAt.getTime()) / DAY_MS));
}

/**
 * A row in the shape the renderer reads: field names at the top level.
 *
 * The return type is keyed by `IssueFieldName`, so a field added to a layout
 * without being projected here is a compile error rather than an empty column.
 */
export function issueRecordRow(
  row: IssueRecordSource,
  now: number,
): Record<IssueFieldName, unknown> & { issueRecordId: string; recordType: IssueRecordType } {
  return {
    issueRecordId: row.issueRecordId,
    recordType: row.recordType,
    title: row.title,
    severity: row.severity,
    stage: row.stage,
    ownerUserId: row.ownerUserId,
    partyId: row.partyId,
    partyName: row.partyName,
    dealId: row.dealId,
    dealTitle: row.dealTitle,
    dueAt: row.dueAt?.toISOString() ?? null,
    openedAt: row.openedAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    ageDays: ageDays(row, now),
    details: row.details,
    reference: row.reference,
  };
}
