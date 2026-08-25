import {
  assessDuplicate,
  AUTO_MERGE_THRESHOLD,
  REVIEW_THRESHOLD,
  type PartyFingerprint,
} from "../party/party-duplicates";
import type { MappedColumn } from "./column-mapping";

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

    if (column.mapping.kind === "mapped") values[column.mapping.field] = cell;
    else if (column.mapping.kind === "custom") customFields[column.mapping.key] = cell;
    // `ambiguous` and `unmapped` contribute nothing: an unanswered question must
    // not quietly become an answer.
  });

  return { values, customFields };
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
