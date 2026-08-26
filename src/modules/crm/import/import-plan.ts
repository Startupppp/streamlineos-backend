import type { PartyFingerprint } from "../../party/party-duplicates";
import type { MappedColumn } from "./column-mapping";
import type { Draft, RowMatch } from "./import-draft";
import {
  ANCHOR_PARTY_ID,
  anchorOf,
  matchStrategyFor,
  requiredFieldOf,
  type ImportEntity,
} from "./import-entities";
import {
  BlockingIndex,
  fingerprintOf,
  matchByFingerprint,
  repeatByFingerprint,
} from "./import-plan-party";
import { readRow } from "./import-row-reader";

/**
 * Deciding what an import would do, before it does any of it.
 *
 * Pure, and the same function produces the preview and drives the commit — not
 * two implementations that agree by inspection. The criterion is that "the
 * committed result matches the preview", and the only way to guarantee that is
 * for there to be one plan, computed once, shown and then executed.
 *
 * One plan for four entities, too. What changes per entity is the vocabulary,
 * how two rows are decided to be the same record, and whether the row has to
 * hang off something — all three declared in `import-entities.ts`. The two
 * passes, the folding, the summary and the stored rows do not change, because a
 * second planner is how the preview and the commit start disagreeing again.
 */

/** One definition, owned by the schema layer that stores it. */
export type { RowAction } from "../../../db/schema/crm/imports";
import type { RowAction } from "../../../db/schema/crm/imports";

/** Re-exported so callers of the plan do not have to know where the enum lives. */
export { isPartyType, type PartyType } from "./import-entities";

export type { RowMatch } from "./import-draft";

export interface PlannedRow {
  /** 1-based, matching what the user sees in their spreadsheet. */
  readonly rowNumber: number;
  readonly action: RowAction;
  /** Plain language, shown per row in the preview. */
  readonly reason: string;
  readonly values: Readonly<Record<string, string>>;
  readonly customFields: Readonly<Record<string, string>>;
  /**
   * The existing record this row updates, or was unsure about.
   *
   * Named for the record rather than the party: which table it lives in is
   * decided by the import's `target_entity`, on the parent row, so there is no
   * per-row type column to go out of step with it.
   */
  readonly matchedRecordId?: string;
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
  /** Which entity this file is for. Defaults to `party`, as every file was. */
  readonly entity?: ImportEntity;
  readonly columns: readonly MappedColumn[];
  /** Raw cells, in the same order as `columns`. */
  readonly rows: readonly (readonly string[])[];
  /** Party imports: the candidates this file could match, by fingerprint. */
  readonly existing?: readonly PartyFingerprint[];
  /** Key-matched entities: the records already present, by natural key. */
  readonly existingByKey?: Readonly<Record<string, string>>;
  /** The records this file's rows hang off, by the key they name them with. */
  readonly anchors?: Readonly<Record<string, string>>;
}

/**
 * The exact keys a file names, for the entities matched by one.
 *
 * The same argument `blockingKeysFor` makes for parties: the service fetches
 * exactly what this file could refer to rather than an arbitrary slice of the
 * tenant, so the plan is a function of the file and the records it names, and
 * previewing twice gives the same answer.
 */
export function lookupKeysFor(
  entity: ImportEntity,
  columns: readonly MappedColumn[],
  rows: readonly (readonly string[])[],
): { naturalKeys: string[]; anchorKeys: string[] } {
  const strategy = matchStrategyFor(entity);
  const anchor = anchorOf(entity);
  const naturalKeys = new Set<string>();
  const anchorKeys = new Set<string>();

  if (strategy.kind !== "natural-key" && !anchor) return { naturalKeys: [], anchorKeys: [] };

  for (const cells of rows) {
    const { values } = readRow(entity, columns, cells);
    if (strategy.kind === "natural-key") {
      const key = strategy.keyOf(values);
      if (key) naturalKeys.add(key);
    }
    if (anchor) {
      const key = anchor.keyOf(values);
      if (key) anchorKeys.add(key);
    }
  }

  return { naturalKeys: [...naturalKeys], anchorKeys: [...anchorKeys] };
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
  const entity = input.entity ?? "party";
  const required = requiredFieldOf(entity);
  const strategy = matchStrategyFor(entity);
  const anchor = anchorOf(entity);

  const drafts: Draft[] = [];
  const survivors: { draft: Draft; fingerprint: PartyFingerprint }[] = [];
  const withinFile = new BlockingIndex();
  const byNaturalKey = new Map<string, Draft>();

  // ── Pass one: the file against itself ───────────────────────────────────
  input.rows.forEach((cells, index) => {
    const rowNumber = index + 1;
    const { values, customFields } = readRow(entity, input.columns, cells);

    const skip = (reason: string): void => {
      drafts.push({ rowNumber, action: "skip", reason, values, customFields });
    };

    // Every entity has one field without which the row describes nothing.
    if (!values[required.field]?.trim()) {
      skip(required.reason);
      return;
    }

    /**
     * The record this row hangs off, resolved before anything else.
     *
     * Written into `values` so the preview shows it and the commit reads the
     * same answer — the resolution is part of the plan, not something the
     * writer works out again later against a table that has moved on.
     */
    if (anchor) {
      const key = anchor.keyOf(values);
      const resolved = key ? input.anchors?.[key] : undefined;
      if (resolved) values[ANCHOR_PARTY_ID] = resolved;
      else if (anchor.required) {
        skip(anchor.missingReason);
        return;
      }
    }

    const repeated = repeatOf(strategy, { values, survivors, withinFile, byNaturalKey });

    if (repeated) {
      fold(repeated, { values, customFields });
      if (strategy.kind === "fingerprint") reindex(repeated, survivors, withinFile);

      drafts.push({
        rowNumber,
        action: "merge",
        reason: `Repeats row ${String(repeated.rowNumber)} of this file; its values were folded into that row.`,
        values,
        customFields,
        duplicateOfRow: repeated.rowNumber,
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

    if (strategy.kind === "fingerprint") {
      const fingerprint = fingerprintOf(rowNumber, values);
      survivors.push({ draft, fingerprint });
      withinFile.add(survivors.length - 1, fingerprint);
    } else if (strategy.kind === "natural-key") {
      const key = strategy.keyOf(values);
      if (key) byNaturalKey.set(key, draft);
    }
  });

  // ── Pass two: the surviving rows against what already exists ────────────
  if (strategy.kind === "fingerprint") matchByFingerprint(survivors, input.existing ?? []);
  else if (strategy.kind === "natural-key")
    for (const [key, draft] of byNaturalKey) {
      const recordId = input.existingByKey?.[key];
      if (!recordId) continue;

      draft.action = "update";
      draft.reason = "Matches a record you already have; its details will be filled in.";
      draft.matchedRecordId = recordId;
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

/** The earlier row of this same file that this one repeats, if there is one. */
function repeatOf(
  strategy: ReturnType<typeof matchStrategyFor>,
  state: {
    values: Record<string, string>;
    survivors: { draft: Draft; fingerprint: PartyFingerprint }[];
    withinFile: BlockingIndex;
    byNaturalKey: Map<string, Draft>;
  },
): Draft | null {
  if (strategy.kind === "natural-key") {
    const key = strategy.keyOf(state.values);
    // No key is not a match. Two subjects with no reference are two subjects.
    return (key && state.byNaturalKey.get(key)) || null;
  }

  if (strategy.kind !== "fingerprint") return null;
  return repeatByFingerprint(state.survivors, state.withinFile, state.values);
}

/**
 * Re-fingerprints a survivor after a fold, and tells the index about it.
 *
 * The fold may have supplied an identifier the surviving row did not have, and
 * the index has to know or a third occurrence matching only on that identifier
 * would be missed.
 */
function reindex(
  survivor: Draft,
  survivors: { draft: Draft; fingerprint: PartyFingerprint }[],
  withinFile: BlockingIndex,
): void {
  const position = survivors.findIndex((candidate) => candidate.draft === survivor);
  if (position < 0) return;

  survivors[position]!.fingerprint = fingerprintOf(survivor.rowNumber, survivor.values);
  withinFile.add(position, survivors[position]!.fingerprint);
}

/**
 * The party half, re-exported so a caller has one place to import the plan from.
 *
 * `blockingKeysFor` is the service's own call, and it is about parties whichever
 * file it lives in.
 */
export { blockingKeysFor, type BlockingKeys } from "./import-plan-party";
