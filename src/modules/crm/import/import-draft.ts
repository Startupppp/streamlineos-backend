import type { RowAction } from "../../../db/schema/crm/imports";

/**
 * A row part-way through being planned, and what the scorer saw.
 *
 * Its own file for the same reason `readRow` has one: both halves of the
 * planner mutate a draft — the generic passes and the party-specific matching —
 * and putting the type in either would make the other import it, which is a
 * cycle rather than a dependency.
 */

/** What the scorer saw, where what it saw is the row's decision. */
export interface RowMatch {
  readonly score: number;
  readonly signals: readonly string[];
  /** The candidate's name, so a person can judge the row without a second query. */
  readonly candidateName?: string;
}

/** A row on its way to becoming a `PlannedRow`; `values` are folded into in place. */
export interface Draft {
  rowNumber: number;
  action: RowAction;
  reason: string;
  values: Record<string, string>;
  customFields: Record<string, string>;
  matchedRecordId?: string;
  duplicateOfRow?: number;
  match?: RowMatch;
}
