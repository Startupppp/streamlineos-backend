import type { ReversibilityClass } from "../../db/schema/crm/autonomous-decisions";
import type { FindingSeverity, ProposedAction } from "../../db/schema/crm/data-quality";

/**
 * The queue's shared vocabulary, and the two rules that make it enforceable.
 *
 * Pure on purpose. Whether a bulk decision may be undone and what a dataset's
 * health number is are both things that should be arguable against a test rather
 * than against a running database.
 */

/**
 * What one open finding costs the dataset's health number.
 *
 * The ratio is the whole content of this table. Four hundred stale leads must
 * not outrank two customers whose tax numbers contradict each other, because the
 * first is a housekeeping afternoon and the second is an invoice going to the
 * wrong company. Weighted counting is what expresses that; a raw count says they
 * are the same problem two hundred times over.
 */
export const SEVERITY_WEIGHTS: Readonly<Record<FindingSeverity, number>> = {
  high: 8,
  medium: 3,
  low: 1,
};

/**
 * How reversible each action the system might take actually is.
 *
 * Declared beside the action rather than chosen by the producer, so two
 * producers proposing the same action cannot disagree about whether it can be
 * taken back. A producer picks the action; the action fixes the class.
 */
export const ACTION_REVERSIBILITY: Readonly<Record<ProposedAction, ReversibilityClass>> = {
  /**
   * `party_merges` captures both rows verbatim before merging and `revert()`
   * replays that snapshot, so a single reversing write undoes it completely.
   */
  "merge-parties": "instant",
  /**
   * Nothing was done to any record, so the only thing to undo is the queue
   * state, and reopening a finding is a single write.
   */
  none: "instant",
};

/** Strictest last: an undo has to survive the worst member of a batch. */
const STRICTNESS: Readonly<Record<ReversibilityClass, number>> = {
  instant: 0,
  hold: 1,
  irreversible: 2,
};

/**
 * The reversibility of a decision covering many findings.
 *
 * A batch is only as reversible as its least reversible member. Taking the most
 * common class, or the first, would offer an undo that silently does nothing for
 * part of the selection — which is worse than refusing, because the person
 * believes it worked.
 *
 * An empty selection is `instant`: there is nothing that cannot be taken back.
 */
export function strictestReversibility(
  classes: readonly ReversibilityClass[],
): ReversibilityClass {
  let strictest: ReversibilityClass = "instant";
  for (const candidate of classes)
    if (STRICTNESS[candidate] > STRICTNESS[strictest]) strictest = candidate;
  return strictest;
}

/**
 * The dataset's health, as one number that moves.
 *
 * Deliberately a penalty rather than a score out of a hundred: a percentage
 * needs a denominator, and the honest denominator — how many records *could*
 * have been wrong — is not something the queue knows. A weighted count of what
 * is open is comparable against itself over time, which is the question being
 * asked.
 */
export function weightedOpenCount(
  counts: readonly { severity: FindingSeverity; count: number }[],
): number {
  return counts.reduce((total, row) => total + SEVERITY_WEIGHTS[row.severity] * row.count, 0);
}
