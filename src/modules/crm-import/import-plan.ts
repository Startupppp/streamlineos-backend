import { partyTypeEnum } from "../../db/schema";
import {
  assessDuplicate,
  AUTO_MERGE_THRESHOLD,
  normaliseEmail,
  normaliseHost,
  normalisePhone,
  normaliseTaxNumber,
  REVIEW_THRESHOLD,
  type PartyFingerprint,
} from "../party/party-duplicates";
import { customKeyFor, normaliseHeader, type ImportField, type MappedColumn } from "./column-mapping";

/**
 * Deciding what an import would do, before it does any of it.
 *
 * Pure, and the same function produces the preview and drives the commit — not
 * two implementations that agree by inspection. The criterion is that "the
 * committed result matches the preview", and the only way to guarantee that is
 * for there to be one plan, computed once, shown and then executed.
 */

/** One definition, owned by the schema layer that stores it. */
export type { RowAction } from "../../db/schema/crm/imports";
import type { RowAction } from "../../db/schema/crm/imports";

export interface PlannedRow {
  /** 1-based, matching what the user sees in their spreadsheet. */
  readonly rowNumber: number;
  readonly action: RowAction;
  /** Plain language, shown per row in the preview. */
  readonly reason: string;
  readonly values: Readonly<Record<string, string>>;
  readonly customFields: Readonly<Record<string, string>>;
  /** The existing record this row updates or duplicates. */
  readonly matchedPartyId?: string;
  /** An earlier row in this same file that this one repeats. */
  readonly duplicateOfRow?: number;
}

export interface ImportPlan {
  readonly rows: readonly PlannedRow[];
  readonly summary: {
    readonly create: number;
    readonly update: number;
    readonly skip: number;
    readonly total: number;
  };
}

export interface PlanInput {
  readonly columns: readonly MappedColumn[];
  /** Raw cells, in the same order as `columns`. */
  readonly rows: readonly (readonly string[])[];
  readonly existing: readonly PartyFingerprint[];
}

/** The party types the column actually accepts, named by the schema that owns them. */
export type PartyType = (typeof partyTypeEnum.enumValues)[number];

export function isPartyType(value: unknown): value is PartyType {
  return typeof value === "string" && (partyTypeEnum.enumValues as readonly string[]).includes(value);
}

/**
 * What another product's export calls each of our party types.
 *
 * `party_type` is a database enum, so a file saying "Supplier" cannot be written
 * through unchanged — and a file saying "Supplier" plainly means VENDOR. The
 * list is deliberately short: a word not on it is not guessed at, because
 * guessing a party's type wrongly is how a supplier list arrives as customers.
 */
const PARTY_TYPE_WORDS: Readonly<Record<string, PartyType>> = {
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

/**
 * The value a field can actually hold, or `null` if this cell cannot be one.
 *
 * Applied while the row is read rather than at commit time, so the preview shows
 * the value that will be written instead of the value the file happened to
 * spell. That is the whole point of planning once: `Type = "Supplier"` has to
 * read as VENDOR in the preview *and* land as VENDOR, and a coercion that only
 * the commit knows about re-opens the divergence this module exists to close.
 */
function coerceValue(field: ImportField, cell: string): string | null {
  if (field === "partyType") {
    const upper = cell.trim().toUpperCase();
    if (isPartyType(upper)) return upper;

    const normalised = cell
      .trim()
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[_\-/]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return PARTY_TYPE_WORDS[normalised] ?? null;
  }

  // Free text in the schema, so the only question is whether it fits.
  if (field === "status") return cell.length <= MAX_STATUS ? cell : null;

  return cell;
}

/** Read one spreadsheet row into named values, per the confirmed mapping. */
function readRow(
  columns: readonly MappedColumn[],
  cells: readonly string[],
): { values: Record<string, string>; customFields: Record<string, string> } {
  const values: Record<string, string> = {};
  const customFields: Record<string, string> = {};

  columns.forEach((column, index) => {
    const cell = (cells[index] ?? "").trim();
    if (!cell) return;

    if (column.mapping.kind === "mapped") {
      const value = coerceValue(column.mapping.field, cell);
      if (value !== null) values[column.mapping.field] = value;
      // A cell that cannot be the field it was mapped to still came out of the
      // user's file, and a column they can see and cannot find afterwards is
      // data loss they discover months later. It keeps its own header's key.
      else customFields[customKeyFor(normaliseHeader(column.header))] = cell;
    } else if (column.mapping.kind === "custom") customFields[column.mapping.key] = cell;
    // `ambiguous` and `unmapped` contribute nothing: an unanswered question must
    // not quietly become an answer.
  });

  return { values, customFields };
}

/**
 * The identifiers a file could possibly match an existing party on.
 *
 * Used to fetch candidates instead of reading an arbitrary slice of the tenant:
 * "the first ten thousand parties Postgres happened to return" is not a stable
 * set, so the same file previewed twice could plan a row as `update` once and
 * `create` the next time, and quietly grow a second copy of a customer.
 *
 * These four keys are enough, and that is a property of the weights in
 * `party-duplicates`, not a hope. Without a shared tax number, e-mail address,
 * phone number or website host, the most a pair can score is a matching e-mail
 * DOMAIN (0.12) plus an exactly equal name (0.3) — 0.42, below the 0.45 review
 * threshold and far below the 0.85 at which a row becomes an update. So a party
 * sharing none of these four cannot change any row's action, and not fetching it
 * costs nothing. `import-plan.spec` pins that arithmetic, because raising a name
 * weight past it would make this blocking unsound silently.
 */
export interface BlockingKeys {
  readonly taxNumbers: readonly string[];
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly hosts: readonly string[];
}

export function blockingKeysFor(
  columns: readonly MappedColumn[],
  rows: readonly (readonly string[])[],
): BlockingKeys {
  const taxNumbers = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  const hosts = new Set<string>();

  const add = (into: Set<string>, key: string): void => {
    if (key) into.add(key);
  };

  for (const cells of rows) {
    // Read through the same mapping the plan uses, so the keys come from the
    // columns the user confirmed rather than from wherever the file put them.
    const { values } = readRow(columns, cells);
    add(taxNumbers, normaliseTaxNumber(values.taxNumber));
    add(emails, normaliseEmail(values.email));
    add(phones, normalisePhone(values.phone));
    add(hosts, normaliseHost(values.website));
  }

  return {
    taxNumbers: [...taxNumbers],
    emails: [...emails],
    phones: [...phones],
    hosts: [...hosts],
  };
}

function fingerprintOf(rowNumber: number, values: Record<string, string>): PartyFingerprint {
  return {
    partyId: `row:${rowNumber}`,
    name: values.name ?? "",
    legalName: values.legalName ?? null,
    email: values.email ?? null,
    phone: values.phone ?? null,
    taxNumber: values.taxNumber ?? null,
    website: values.website ?? null,
  };
}

/**
 * What this file would do to this organisation.
 *
 * Order matters. A row is checked against earlier rows in the same file first,
 * because a file that lists one company twice should create it once — and if it
 * were checked against the database first, both copies would look new and both
 * would be created.
 */
export function planImport(input: PlanInput): ImportPlan {
  const planned: PlannedRow[] = [];
  const seen: { rowNumber: number; fingerprint: PartyFingerprint }[] = [];

  input.rows.forEach((cells, index) => {
    const rowNumber = index + 1;
    const { values, customFields } = readRow(input.columns, cells);

    // A party is its name. Without one there is nothing to create.
    if (!values.name?.trim()) {
      planned.push({
        rowNumber,
        action: "skip",
        reason: "No name in this row, so there is nothing to create.",
        values,
        customFields,
      });
      return;
    }

    const fingerprint = fingerprintOf(rowNumber, values);

    const withinFile = seen.find(
      (candidate) => assessDuplicate(candidate.fingerprint, fingerprint).score >= AUTO_MERGE_THRESHOLD,
    );

    if (withinFile) {
      planned.push({
        rowNumber,
        action: "skip",
        reason: `Repeats row ${withinFile.rowNumber} of this file.`,
        values,
        customFields,
        duplicateOfRow: withinFile.rowNumber,
      });
      return;
    }

    seen.push({ rowNumber, fingerprint });

    let best: { partyId: string; score: number } | null = null;
    for (const candidate of input.existing) {
      const { score, blockers } = assessDuplicate(candidate, fingerprint);
      // A contradiction — two different tax numbers — is proof these are
      // different companies, however similar the names look.
      if (blockers.length > 0) continue;
      if (!best || score > best.score) best = { partyId: candidate.partyId, score };
    }

    if (best && best.score >= AUTO_MERGE_THRESHOLD) {
      planned.push({
        rowNumber,
        action: "update",
        reason: "Matches a party you already have; its details will be filled in.",
        values,
        customFields,
        matchedPartyId: best.partyId,
      });
      return;
    }

    /**
     * A near-match is not an update.
     *
     * Between the two thresholds the system is unsure, and quietly merging into
     * an existing customer is the expensive mistake — it fuses two companies'
     * histories, which a later reversal cannot cleanly separate. Creating a
     * second record is the cheap one, and the duplicate queue from ticket 06
     * already exists to catch it afterwards.
     */
    if (best && best.score >= REVIEW_THRESHOLD) {
      planned.push({
        rowNumber,
        action: "create",
        reason: "Looks similar to an existing party, but not close enough to be sure — created separately for review.",
        values,
        customFields,
        matchedPartyId: best.partyId,
      });
      return;
    }

    planned.push({
      rowNumber,
      action: "create",
      reason: "New to this organisation.",
      values,
      customFields,
    });
  });

  return {
    rows: planned,
    summary: {
      create: planned.filter((row) => row.action === "create").length,
      update: planned.filter((row) => row.action === "update").length,
      skip: planned.filter((row) => row.action === "skip").length,
      total: planned.length,
    },
  };
}
