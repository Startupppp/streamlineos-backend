import {
  ISSUE_RECORD_TYPES,
  ISSUE_SEVERITIES,
  ISSUE_STAGES,
  type IssueRecordType,
  type IssueSeverity,
} from "../../db/schema/crm/issue-records";

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
 * The declaration and the projection are generated from ONE map below, and the
 * types are what enforce it: a field that exists in a layout but not in
 * `issueRecordRow` fails to compile, and so does the reverse. That mattersw
 * because the failure mode here is silent — a column whose name the row does not
 * carry renders as an empty cell, on every row, forever.
 */

/** Mirrors the renderer's `SelectOption`. */
export interface IssueFieldOption {
  readonly value: string;
  readonly label: string;
  /** Maps onto the design layer's status tokens, never a raw colour. */
  readonly tone?: "success" | "warning" | "danger" | "info" | "neutral";
}

/** Mirrors the renderer's `FieldSpec` exactly, so no translation layer exists. */
export interface IssueFieldSpec {
  readonly name: string;
  readonly label: string;
  readonly kind: "text" | "number" | "date" | "select" | "badge" | "longText";
  readonly required?: boolean;
  readonly readOnly?: boolean;
  readonly options?: readonly IssueFieldOption[];
  readonly hint?: string;
  readonly editOnly?: boolean;
}

export interface IssueColumnSpec {
  readonly field: string;
  readonly primary?: boolean;
  readonly sortable?: boolean;
  readonly width?: string;
  readonly subtitle?: string;
}

export interface IssueSectionSpec {
  readonly title: string;
  readonly fields: readonly string[];
}

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

const SEVERITY_TONES: Readonly<Record<IssueSeverity, IssueFieldOption["tone"]>> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

// Derived from the schema's own list rather than restated, so a fourth band
// would reach the form by adding one tone instead of by remembering to.
const SEVERITY_OPTIONS: readonly IssueFieldOption[] = ISSUE_SEVERITIES.map((severity) => ({
  value: severity,
  label: severity.charAt(0).toUpperCase() + severity.slice(1),
  tone: SEVERITY_TONES[severity],
}));

const STAGE_TONES: Readonly<Record<(typeof ISSUE_STAGES)[number], IssueFieldOption["tone"]>> = {
  open: "info",
  acknowledged: "neutral",
  escalated: "danger",
  resolved: "success",
  dismissed: "neutral",
};

const STAGE_OPTIONS: readonly IssueFieldOption[] = ISSUE_STAGES.map((stage) => ({
  value: stage,
  label: stage.charAt(0).toUpperCase() + stage.slice(1),
  tone: STAGE_TONES[stage],
}));

export const ISSUE_FIELD_NAMES = [
  "title",
  "severity",
  "stage",
  "ownerUserId",
  "partyId",
  "partyName",
  "dealId",
  "dealTitle",
  "dueAt",
  "openedAt",
  "acknowledgedAt",
  "closedAt",
  "ageDays",
  "details",
  "reference",
] as const;
export type IssueFieldName = (typeof ISSUE_FIELD_NAMES)[number];

/**
 * Every field the three types draw from, declared once.
 *
 * `stage` is `readOnly`, and that is load-bearing rather than cosmetic. The
 * renderer's `formFields` drops read-only fields, so the generated form is
 * physically incapable of moving a record's stage — which means the transition
 * endpoint is the only path, and the ledger cannot be bypassed by editing the
 * record. A writable stage control would have made criterion 4 a convention.
 */
const FIELD: Readonly<Record<IssueFieldName, IssueFieldSpec>> = {
  title: { name: "title", label: "Summary", kind: "text", required: true },
  severity: {
    name: "severity",
    label: "Severity",
    kind: "select",
    required: true,
    options: SEVERITY_OPTIONS,
    hint: "The same three bands the data-quality queue uses, and weighted the same way.",
  },
  stage: {
    name: "stage",
    label: "Stage",
    kind: "badge",
    readOnly: true,
    options: STAGE_OPTIONS,
    hint: "Moved through the transition ledger, never by editing the record.",
  },
  ownerUserId: {
    name: "ownerUserId",
    label: "Owner",
    kind: "text",
    hint: "Whose job this is. Left empty, it is nobody's.",
  },
  partyId: {
    name: "partyId",
    label: "Party",
    kind: "text",
    hint: "The customer or supplier this concerns.",
  },
  partyName: { name: "partyName", label: "Party", kind: "text", readOnly: true },
  dealId: {
    name: "dealId",
    label: "Deal",
    kind: "number",
    hint: "The deal this sits against, so the commercial consequence is visible on it.",
  },
  dealTitle: { name: "dealTitle", label: "Deal", kind: "text", readOnly: true },
  dueAt: { name: "dueAt", label: "Due", kind: "date" },
  openedAt: { name: "openedAt", label: "Opened", kind: "date", readOnly: true },
  acknowledgedAt: {
    name: "acknowledgedAt",
    label: "Acknowledged",
    kind: "date",
    readOnly: true,
  },
  closedAt: { name: "closedAt", label: "Closed", kind: "date", readOnly: true },
  ageDays: { name: "ageDays", label: "Age (days)", kind: "number", readOnly: true },
  details: { name: "details", label: "Details", kind: "longText" },
  reference: {
    name: "reference",
    label: "Reference",
    kind: "text",
    hint: "Your own code for this record — a ticket number your desk already mints.",
  },
};

/** Carried by every type, appended rather than declared three times. */
const RECORD_SECTION: IssueSectionSpec = {
  title: "Record",
  fields: ["openedAt", "acknowledgedAt", "closedAt", "ageDays"],
};

interface TypeDeclaration {
  readonly singular: string;
  readonly plural: string;
  /** Which fields this type shows, in order, before the platform ones. */
  readonly declared: readonly IssueFieldName[];
  readonly columns: readonly IssueColumnSpec[];
  /** Overrides applied on top of `FIELD`, for the one thing types disagree about. */
  readonly overrides?: Partial<Record<IssueFieldName, Partial<IssueFieldSpec>>>;
}

/**
 * What the three actually disagree about, which is less than it looks.
 *
 * They share severity, an owner, a clock and an accountability ledger. What
 * differs is who raises them, what a complaint is required to anchor to, and the
 * words on the screen. Manufacturing more difference than that is how three
 * record types become three modules.
 */
const DECLARATIONS: Readonly<Record<IssueRecordType, TypeDeclaration>> = {
  issue: {
    singular: "Issue",
    plural: "Issues",
    declared: ["title", "severity", "stage", "ownerUserId", "dueAt", "details", "reference", "partyId", "partyName", "dealId", "dealTitle"],
    columns: [
      { field: "title", primary: true, sortable: true },
      { field: "severity", width: "w-28 shrink-0" },
      { field: "stage", width: "w-32 shrink-0" },
      { field: "ownerUserId", width: "min-w-[140px]" },
      { field: "openedAt", sortable: true, width: "w-32 shrink-0" },
    ],
  },
  task: {
    singular: "Task",
    plural: "Tasks",
    declared: ["title", "severity", "stage", "ownerUserId", "dueAt", "details", "reference", "partyId", "partyName", "dealId", "dealTitle"],
    columns: [
      { field: "title", primary: true, sortable: true },
      { field: "severity", width: "w-28 shrink-0" },
      { field: "stage", width: "w-32 shrink-0" },
      { field: "ownerUserId", width: "min-w-[140px]" },
      { field: "dueAt", sortable: true, width: "w-32 shrink-0" },
    ],
  },
  complaint: {
    singular: "Complaint",
    plural: "Complaints",
    declared: ["title", "partyId", "partyName", "dealId", "dealTitle", "severity", "stage", "ownerUserId", "dueAt", "details", "reference"],
    columns: [
      { field: "title", primary: true, sortable: true, subtitle: "partyName" },
      { field: "partyName", width: "min-w-[160px]" },
      { field: "severity", width: "w-28 shrink-0" },
      { field: "stage", width: "w-32 shrink-0" },
      { field: "dueAt", sortable: true, width: "w-32 shrink-0" },
    ],
    /**
     * Criterion 2, expressed in the description rather than only in a CHECK.
     * A complaint from nobody cannot be traced to the relationship it damaged,
     * so the form refuses to submit one — and 0290's CHECK refuses it again for
     * every writer that never sees a form.
     */
    overrides: { partyId: { required: true } },
  },
};

/** Fields shown but never submitted, appended after the declared ones. */
const PLATFORM_FIELDS: readonly IssueFieldName[] = [
  "openedAt",
  "acknowledgedAt",
  "closedAt",
  "ageDays",
];

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
