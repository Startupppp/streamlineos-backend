import { partyTypeEnum } from "../../../db/schema";
import {
  assessDuplicate,
  AUTO_MERGE_THRESHOLD,
  normaliseEmail,
  normaliseHost,
  normalisePhone,
  normaliseTaxNumber,
  REVIEW_THRESHOLD,
  type PartyFingerprint,
} from "../../party/party-duplicates";
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
export type { RowAction } from "../../../db/schema/crm/imports";
import type { RowAction } from "../../../db/schema/crm/imports";

/** What the scorer saw, where what it saw is the row's decision. */
export interface RowMatch {
  readonly score: number;
  readonly signals: readonly string[];
  /** The candidate's name, so a person can judge the row without a second query. */
  readonly candidateName?: string;
}

export interface PlannedRow {
  /** 1-based, matching what the user sees in their spreadsheet. */
  readonly rowNumber: number;
  readonly action: RowAction;
  /** Plain language, shown per row in the preview. */
  readonly reason: string;
  readonly values: Readonly<Record<string, string>>;
  readonly customFields: Readonly<Record<string, string>>;
  /** The existing record this row updates, or was unsure about. */
  readonly matchedPartyId?: string;
  /** An earlier row in this same file that this one was folded into. */
  readonly duplicateOfRow?: number;
  /** Present on `update` and `review`: why the scorer landed where it did. */
  readonly match?: RowMatch;
}

/**
 * A type alias rather than an interface: this is stored in a `jsonb` column
 * typed `Record<string, number>`, and TypeScript gives an object type alias an
 * implicit index signature while an interface gets none.
 */
export type ImportSummary = {
  readonly create: number;
  readonly update: number;
  /** Folded into an earlier row of this same file. */
  readonly merge: number;
  /** Held for a person: written nowhere, filed in the data-quality queue. */
  readonly review: number;
  readonly skip: number;
  readonly total: number;
};

export interface ImportPlan {
  readonly rows: readonly PlannedRow[];
  readonly summary: ImportSummary;
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

/**
 * The same four identifiers as one list, prefixed by kind.
 *
 * Prefixed because a tax number and a phone number can be the same digits, and
 * an index that let them collide would compare pairs that share nothing —
 * harmless for correctness, but it re-introduces the cost this exists to remove.
 */
function blockingKeysOf(fingerprint: PartyFingerprint): string[] {
  return [
    `t:${normaliseTaxNumber(fingerprint.taxNumber)}`,
    `e:${normaliseEmail(fingerprint.email)}`,
    `p:${normalisePhone(fingerprint.phone)}`,
    `h:${normaliseHost(fingerprint.website)}`,
  ].filter((key) => key.length > 2);
}

/**
 * Which records are worth comparing against which, by shared identifier.
 *
 * Comparing every row against every row is quadratic, and at the file sizes this
 * ticket is about that is the preview's own ceiling — five thousand rows is
 * twelve million scorings before anything is written. The soundness argument is
 * exactly the one `blockingKeysFor` makes for the database side, only stricter:
 * a pair sharing none of the four identifiers tops out at 0.42, and the bar for
 * folding two rows together is 0.85.
 */
class BlockingIndex {
  private readonly byKey = new Map<string, number[]>();

  add(position: number, fingerprint: PartyFingerprint): void {
    for (const key of blockingKeysOf(fingerprint)) {
      const positions = this.byKey.get(key);
      if (!positions) this.byKey.set(key, [position]);
      else if (positions.at(-1) !== position) positions.push(position);
    }
  }

  /**
   * Ascending, and deduplicated.
   *
   * Order is not cosmetic: the caller takes the FIRST match, so this decides
   * which row a repeat is folded into. Ascending means the earliest occurrence
   * in the file wins, which is what a person reading their spreadsheet expects.
   */
  candidates(fingerprint: PartyFingerprint): number[] {
    const found = new Set<number>();
    for (const key of blockingKeysOf(fingerprint))
      for (const position of this.byKey.get(key) ?? []) found.add(position);
    return [...found].sort((left, right) => left - right);
  }
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

/** A row on its way to becoming a `PlannedRow`; `values` are folded into in place. */
interface Draft {
  rowNumber: number;
  action: RowAction;
  reason: string;
  values: Record<string, string>;
  customFields: Record<string, string>;
  matchedPartyId?: string;
  duplicateOfRow?: number;
  match?: RowMatch;
}

/**
 * Folds a repeated row into the one it repeats, filling gaps only.
 *
 * A file that lists Acme twice, once with the phone number and once with the
 * e-mail, describes one company that has both. Dropping the second line — which
 * is what reporting it as a skip amounted to — loses a column the user can see
 * in their own file. First occurrence wins on conflict, matching the rule the
 * commit already applies to an existing party: a value already present is not
 * overwritten by a later one.
 */
function fold(into: Draft, from: { values: Record<string, string>; customFields: Record<string, string> }): void {
  for (const [key, value] of Object.entries(from.values))
    if (value && !into.values[key]) into.values[key] = value;

  for (const [key, value] of Object.entries(from.customFields))
    if (value && !into.customFields[key]) into.customFields[key] = value;
}

/**
 * What this file would do to this organisation.
 *
 * Two passes, and the order between them is the same one Phase 1 had for the
 * same reason: a file that lists one company twice must create it once, and
 * checking against the database first would make both copies look new and create
 * both. Separating the passes rather than interleaving them is what lets a fold
 * change the surviving row's identifiers — a repeat that supplies the tax number
 * the first line lacked genuinely changes which existing party the survivor
 * matches, and a single interleaved pass would have matched it already.
 */
export function planImport(input: PlanInput): ImportPlan {
  const drafts: Draft[] = [];

  // ── Pass one: the file against itself ───────────────────────────────────
  const survivors: { draft: Draft; fingerprint: PartyFingerprint }[] = [];
  const withinFile = new BlockingIndex();

  input.rows.forEach((cells, index) => {
    const rowNumber = index + 1;
    const { values, customFields } = readRow(input.columns, cells);

    // A party is its name. Without one there is nothing to create.
    if (!values.name?.trim()) {
      drafts.push({
        rowNumber,
        action: "skip",
        reason: "No name in this row, so there is nothing to create.",
        values,
        customFields,
      });
      return;
    }

    const fingerprint = fingerprintOf(rowNumber, values);

    const repeated = withinFile
      .candidates(fingerprint)
      .find(
        (position) =>
          assessDuplicate(survivors[position]!.fingerprint, fingerprint).score >=
          AUTO_MERGE_THRESHOLD,
      );

    if (repeated !== undefined) {
      const survivor = survivors[repeated]!;
      fold(survivor.draft, { values, customFields });
      // Re-fingerprinted because the fold may have supplied an identifier the
      // surviving row did not have, and the index has to know about it or a
      // third occurrence matching only on that identifier would be missed.
      survivor.fingerprint = fingerprintOf(survivor.draft.rowNumber, survivor.draft.values);
      withinFile.add(repeated, survivor.fingerprint);

      drafts.push({
        rowNumber,
        action: "merge",
        reason: `Repeats row ${String(survivor.draft.rowNumber)} of this file; its values were folded into that row.`,
        values,
        customFields,
        duplicateOfRow: survivor.draft.rowNumber,
      });
      return;
    }

    const draft: Draft = {
      rowNumber,
      // Decided in pass two, once the row has absorbed every repeat of itself.
      action: "create",
      reason: "New to this organisation.",
      values,
      customFields,
    };

    drafts.push(draft);
    survivors.push({ draft, fingerprint });
    withinFile.add(survivors.length - 1, fingerprint);
  });

  // ── Pass two: the surviving rows against what already exists ────────────
  const existingIndex = new BlockingIndex();
  input.existing.forEach((party, position) => existingIndex.add(position, party));

  for (const survivor of survivors) {
    let best: { partyId: string; name: string; score: number; signals: readonly string[] } | null =
      null;

    for (const position of existingIndex.candidates(survivor.fingerprint)) {
      const candidate = input.existing[position]!;
      const { score, blockers, signals } = assessDuplicate(candidate, survivor.fingerprint);
      // A contradiction — two different tax numbers — is proof these are
      // different companies, however similar the names look.
      if (blockers.length > 0) continue;
      if (!best || score > best.score)
        best = { partyId: candidate.partyId, name: candidate.name, score, signals };
    }

    if (!best || best.score < REVIEW_THRESHOLD) continue;

    if (best.score >= AUTO_MERGE_THRESHOLD) {
      survivor.draft.action = "update";
      survivor.draft.reason = "Matches a party you already have; its details will be filled in.";
      survivor.draft.matchedPartyId = best.partyId;
      survivor.draft.match = { score: best.score, signals: best.signals, candidateName: best.name };
      continue;
    }

    /**
     * Between the two thresholds, nothing is written at all.
     *
     * Phase 1 created a second record here and left the duplicate queue to catch
     * it. That is a speculative write, and an import performs it at scale: a
     * file of near-matches silently doubles a customer list, and the person who
     * approved the preview was told "created separately for review" in a row
     * sample they did not read. Holding the row costs them a queue item; writing
     * it costs them a merge they may never notice is needed.
     */
    survivor.draft.action = "review";
    survivor.draft.reason =
      `Looks like "${best.name}", but not close enough to be sure. ` +
      "Held for review rather than creating a second record.";
    survivor.draft.matchedPartyId = best.partyId;
    survivor.draft.match = { score: best.score, signals: best.signals, candidateName: best.name };
  }

  const rows: PlannedRow[] = drafts.map((draft) => ({ ...draft }));
  const count = (action: RowAction): number => rows.filter((row) => row.action === action).length;

  return {
    rows,
    summary: {
      create: count("create"),
      update: count("update"),
      merge: count("merge"),
      review: count("review"),
      skip: count("skip"),
      total: rows.length,
    },
  };
}
