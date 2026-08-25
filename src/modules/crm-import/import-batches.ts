/**
 * Cutting a file into the units a durable run can be resumed between.
 *
 * The whole of ticket 13 turns on one property, so it lives in a pure function
 * that can be argued with: **a batch's name must always mean the same rows.**
 *
 * `step.run` memoises by name. If batch three meant "rows 201-300" on the first
 * attempt and "the next hundred rows still outstanding" on the second, then a
 * resumed run would skip a memo that stands for different work, and rows would
 * be silently dropped from the import. That is why these windows are arithmetic
 * over `row_number` rather than an OFFSET into a live query: the set of
 * outstanding rows shrinks as the import proceeds, so any boundary derived from
 * it moves, while `[201, 300]` does not.
 *
 * `row_number` is uniquely indexed per import and assigned once at preview, so
 * the mapping from window to rows is total, stable and gap-tolerant — a window
 * that happens to hold no outstanding rows costs one indexed lookup.
 */

/**
 * Rows per step, and therefore rows per transaction.
 *
 * The two failure modes pull in opposite directions and this sits between them.
 * Too large and a step is a long transaction again — the thing that made the
 * whole-file step useless, since a timeout rolls back every `committed_at` it
 * wrote. Too small and the run pays a transaction, a step insert and a step
 * replay per handful of rows, and a five-thousand-row file becomes five hundred
 * memos the next attempt has to load and walk.
 */
export const BATCH_ROWS = 100;

/**
 * How long one attempt spends executing NEW batches before releasing the run.
 *
 * Deliberately well under the 30s `statement_timeout` that guards a pooled
 * connection, and under any sensible lease: an attempt that overruns its lease
 * can be claimed by a second worker while it is still writing. It bounds only
 * newly-executed batches — replaying memoised ones is a `SELECT` and costs
 * nothing, so a resumed run is not charged for the work it already did.
 */
export const ATTEMPT_BUDGET_MS = 15_000;

export interface RowWindow {
  /** Position in the file, and the number inside the step's name. */
  readonly index: number;
  /** Inclusive, 1-based, matching what the user sees in their spreadsheet. */
  readonly fromRow: number;
  readonly toRow: number;
}

/**
 * Every window of a file, in file order.
 *
 * Derived from the highest row number rather than from a count, because a plan
 * whose rows were partly deleted still has to be walked to its end — counting
 * would stop short and leave the tail of the file unimported with the run
 * reporting success.
 */
export function rowWindows(maxRowNumber: number, size: number = BATCH_ROWS): RowWindow[] {
  if (maxRowNumber <= 0 || size <= 0) return [];

  const windows: RowWindow[] = [];
  for (let index = 0; index * size < maxRowNumber; index += 1)
    windows.push({ index, fromRow: index * size + 1, toRow: (index + 1) * size });

  return windows;
}

/**
 * The name a window's memo is filed under.
 *
 * Prefixed by phase because the commit and the undo are two runs over the same
 * file, and a shared name would let one read the other's memo.
 */
export function batchStepName(phase: "commit" | "revert", index: number): string {
  return `${phase}-batch-${String(index)}`;
}

/**
 * The name of the pause taken after a window.
 *
 * `sync` is a third phase because the connectors walk pages under the same
 * attempt budget, and a page is the unit there rather than a row window.
 *
 * Keyed on the window it follows, so it is unique within a run however many
 * attempts it takes: names must not repeat inside one execution, and a pause
 * that has already elapsed is a completed step a resumed run walks straight
 * past. Which windows a given attempt pauses after depends on how fast the
 * machine was, and that is fine — a name is only ever attached to one decision.
 */
export function pauseStepName(phase: "commit" | "revert" | "sync", index: number): string {
  return `${phase}-pause-after-${String(index)}`;
}
