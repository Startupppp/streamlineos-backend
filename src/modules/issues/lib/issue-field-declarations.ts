import { ISSUE_SEVERITIES, ISSUE_STAGES, type IssueRecordType, type IssueSeverity } from "../../../db/schema/crm/issue-records";

/**
 * The declaration half of the issue record description: the field table and the
 * three types' use of it, with nothing that reads them.
 *
 * The seam is the one `party-layout.ts` already draws — data on one side,
 * accessors on the other. Everything here is a constant evaluated once at module
 * load and never consulted at runtime by this file; `issue-record-types.ts` is
 * the only thing that reads it, and it reads it in exactly one function
 * (`layoutFor`). Keeping the table here means a change to what a field is called
 * or which types show it is a diff against a table, not against the code that
 * assembles a layout out of one.
 *
 * The types that describe the table live here too rather than next to the
 * accessors, because the table is what has to satisfy them — and a lib that
 * imported its own types back from the file it was extracted from would be an
 * import cycle.
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
export const FIELD: Readonly<Record<IssueFieldName, IssueFieldSpec>> = {
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
export const RECORD_SECTION: IssueSectionSpec = {
  title: "Record",
  fields: ["openedAt", "acknowledgedAt", "closedAt", "ageDays"],
};

export interface TypeDeclaration {
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
export const DECLARATIONS: Readonly<Record<IssueRecordType, TypeDeclaration>> = {
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
export const PLATFORM_FIELDS: readonly IssueFieldName[] = [
  "openedAt",
  "acknowledgedAt",
  "closedAt",
  "ageDays",
];
