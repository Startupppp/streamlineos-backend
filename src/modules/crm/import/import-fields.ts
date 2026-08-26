import { partyTypeEnum } from "../../../db/schema";
import { ACTIVITY_KINDS, type ActivityKind } from "../../../db/schema/crm/activities";
import { IMPORT_TARGET_ENTITIES, type ImportTargetEntity } from "../../../db/schema/crm/imports";

/**
 * What a field vocabulary IS, and the coercions any of them may need.
 *
 * Split from the four vocabularies themselves so that the shape and the content
 * are separately readable: this file answers "what can an entity declare", and
 * `import-entities.ts` answers "what do the four actually declare". Nothing here
 * knows which entities exist beyond naming them.
 */

/**
 * The entities a file can be imported as.
 *
 * Named by the schema, because `crm_imports.target_entity` stores one and a
 * CHECK constrains it — a second list here could drift from the constraint and
 * the drift would only show as a 23514 in production.
 */
export const IMPORT_ENTITIES = IMPORT_TARGET_ENTITIES;
export type ImportEntity = ImportTargetEntity;

export function isImportEntity(value: string): value is ImportEntity {
  return (IMPORT_ENTITIES as readonly string[]).includes(value);
}

/**
 * The party fields, unchanged from when they were the only ones.
 *
 * Frozen deliberately. `mapColumn(header)` with the entity left out is what the
 * mapping evals call, and that gate has zero tolerance for a column landing in
 * the wrong field — so making the entity a parameter must not move a single
 * party answer.
 */
export const PARTY_FIELDS = [
  "name",
  "legalName",
  "displayName",
  "email",
  "phone",
  "website",
  "taxNumber",
  "notes",
  "partyType",
  "status",
] as const;

/**
 * The three columns a subject has of its own.
 *
 * Everything else a subject type declares lives in `custom_fields`, so an
 * unrecognised column becoming a custom field is the RIGHT destination here
 * rather than a failure to recognise it — `subject-values.ts` reserves exactly
 * these three names for the same reason.
 */
export const SUBJECT_FIELDS = ["title", "reference", "status"] as const;

/** A deals or opportunities export: rows are deals sitting in a pipeline stage. */
export const PIPELINE_FIELDS = [
  "name",
  "stage",
  "amount",
  "closeDate",
  "probability",
  "nextStep",
  "notes",
  "partyName",
] as const;

export const ACTIVITY_FIELDS = [
  "kind",
  "subject",
  "body",
  "occurredAt",
  "dueAt",
  "partyName",
] as const;

export type ImportField =
  | (typeof PARTY_FIELDS)[number]
  | (typeof SUBJECT_FIELDS)[number]
  | (typeof PIPELINE_FIELDS)[number]
  | (typeof ACTIVITY_FIELDS)[number];

/** Where the anchor a row names is written once it has been resolved. */
export const ANCHOR_PARTY_ID = "anchorPartyId";

/**
 * How a row is decided to be a record that already exists.
 *
 * Three answers rather than one, because the entities genuinely differ.
 * `fingerprint` is the party scorer — several weak identifiers combined. A
 * `natural-key` is a column the database already holds a unique index over, so
 * a hit is certain and there is no band of doubt to hold rows in. `none` says
 * the entity has no business key at all: a deal and an activity can legitimately
 * repeat, so an import of either always creates, and re-importing the same file
 * twice creates twice. That is what the one-action undo is for, and saying it
 * here is better than inventing a key that quietly merges two real deals.
 */
export type MatchStrategy =
  | { readonly kind: "fingerprint" }
  | {
      readonly kind: "natural-key";
      keyOf(values: Readonly<Record<string, string>>): string | null;
    }
  | { readonly kind: "none" };

/**
 * The record a row has to hang off, where the schema insists on one.
 *
 * `chk_activities_one_anchor` requires an activity to belong to exactly one
 * party, deal or subject, so an activities file with no column naming a record
 * cannot be written at all. Resolved while the plan is made rather than at
 * commit time, so the preview shows the rows that will be skipped for want of an
 * anchor instead of discovering them afterwards.
 */
export interface AnchorRule {
  /** The key the file names the record by, normalised for an exact lookup. */
  keyOf(values: Readonly<Record<string, string>>): string | null;
  /** `true` when a row with no resolved anchor cannot be written at all. */
  readonly required: boolean;
  readonly missingReason: string;
}

export interface EntityVocabulary {
  readonly fields: readonly ImportField[];
  readonly synonyms: Readonly<Partial<Record<ImportField, readonly string[]>>>;
  /**
   * Which kind of record this file is about, in `ENTITY_GROUP`'s vocabulary.
   *
   * Lets the mapper tell "Account Name" on a deals export — the customer — from
   * "Deal Name". Left unset for parties so their answers cannot move, and unset
   * for subjects because a tenant's subject is whatever they say it is.
   */
  readonly group?: string;
  /** Without this, the row describes nothing and is skipped. */
  readonly required: { readonly field: ImportField; readonly reason: string };
  /** The value a field can hold, or `null` when this cell cannot be one. */
  coerce(field: ImportField, cell: string): string | null;
  readonly match: MatchStrategy;
  readonly anchor?: AnchorRule;
}

// ── Coercion helpers ───────────────────────────────────────────────────────

/** Lower-cased, punctuation folded — the form both word tables are keyed by. */
export function normaliseWord(cell: string): string {
  return cell
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[_\-/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A company name folded to the form the anchor lookup compares.
 *
 * Case-insensitive, because a file writing `ACME LTD` means the same company as
 * one writing `Acme Ltd` and refusing to see that would skip the row. Matched in
 * SQL against `lower(name)`, which migration 0281 indexes for exactly this —
 * `=` on text is leakproof, so the index is usable under row-level security.
 */
export function normaliseLookupKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export type PartyType = (typeof partyTypeEnum.enumValues)[number];

export function isPartyType(value: unknown): value is PartyType {
  return typeof value === "string" && (partyTypeEnum.enumValues as readonly string[]).includes(value);
}

/**
 * What another product's export calls each of our party types.
 *
 * Deliberately short: a word not on it is not guessed at, because guessing a
 * party's type wrongly is how a supplier list arrives as customers.
 */
export const PARTY_TYPE_WORDS: Readonly<Record<string, PartyType>> = {
  customer: "CUSTOMER",
  client: "CUSTOMER",
  buyer: "CUSTOMER",
  vendor: "VENDOR",
  supplier: "VENDOR",
  seller: "VENDOR",
  partner: "PARTNER",
  reseller: "PARTNER",
  affiliate: "PARTNER",
  both: "BOTH",
  "customer and vendor": "BOTH",
  "customer and supplier": "BOTH",
  "customer vendor": "BOTH",
  "customer supplier": "BOTH",
};

/** As much status as the party API itself accepts; `status` is free text. */
const MAX_STATUS = 50;

export const ACTIVITY_KIND_WORDS: Readonly<Record<string, ActivityKind>> = {
  call: "call",
  phone: "call",
  "phone call": "call",
  "outbound call": "call",
  "inbound call": "call",
  "log a call": "call",
  email: "email",
  "e mail": "email",
  "email message": "email",
  message: "email",
  meeting: "meeting",
  appointment: "meeting",
  demo: "meeting",
  visit: "meeting",
  note: "note",
  comment: "note",
  "log a note": "note",
  task: "task",
  "to do": "task",
  todo: "task",
  "follow up": "task",
};

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === "string" && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/**
 * Money as the integer minor units the column actually stores.
 *
 * Coerced while the row is read rather than at commit time, so the preview shows
 * the number that will be written. A cell that is not money at all becomes a
 * custom field instead of a zero — a silently zeroed forecast is worse than a
 * column somebody has to look at.
 */
export function toMinorUnits(cell: string): string | null {
  const cleaned = cell.replace(/[^\d.-]/g, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const amount = Number(cleaned);
  return Number.isFinite(amount) ? String(Math.round(amount * 100)) : null;
}

/**
 * A date, or nothing, and never a guess.
 *
 * `31/12/2025` is NaN in JavaScript while `12/31/2025` is not, so a
 * day-first file would parse for eleven days of every month and silently land
 * on the wrong day for the other twelve. Every purely numeric separated form is
 * refused for that reason; ISO and month-name spellings are unambiguous and are
 * read. A refused cell keeps its own header as a custom field, so the value is
 * still in the record.
 */
const AMBIGUOUS_NUMERIC_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;

function parseDate(cell: string): Date | null {
  const raw = cell.trim();
  if (!raw || AMBIGUOUS_NUMERIC_DATE.test(raw)) return null;

  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function toDateOnly(cell: string): string | null {
  return parseDate(cell)?.toISOString().slice(0, 10) ?? null;
}

export function toTimestamp(cell: string): string | null {
  return parseDate(cell)?.toISOString() ?? null;
}

export function toPercentage(cell: string): string | null {
  const cleaned = cell.replace(/[^\d.-]/g, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const value = Math.round(Number(cleaned));
  return value >= 0 && value <= 100 ? String(value) : null;
}

/** Free text in the schema, so the only question is whether it fits. */
export function withinStatus(cell: string): string | null {
  return cell.length <= MAX_STATUS ? cell : null;
}

