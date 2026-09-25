/**
 * What a committed row did. A rollback may only undo `created` rows: an import
 * that updated a record the operator already had must not delete it when the job
 * is rolled back, and an `unchanged` row touched nothing to undo.
 */
export type CommitOutcome = "created" | "updated" | "unchanged";

export interface CommitRef {
  table: string;
  id: number;
  outcome: CommitOutcome;
}
