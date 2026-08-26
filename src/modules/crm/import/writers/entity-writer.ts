import type { TenantTx } from "../../../../db/drizzle.types";
import type { ImportEntity } from "../import-entities";

/**
 * The one thing that genuinely differs per entity: which table a planned row
 * lands in.
 *
 * Everything above this — the mapping, the plan, the preview, the durable
 * commit, the claim per row, the thirty-day undo — is shared, and that is the
 * ticket's own instruction: each additional entity is a writer and a synonym
 * table, not a second import pipeline. This interface is the seam that makes
 * that true rather than aspirational, because there is nowhere else a new
 * entity could add a code path.
 *
 * Every method takes `tx` explicitly. The commit runs one savepoint per row, and
 * a write that went to the ambient transaction instead would survive the
 * savepoint's rollback and leave half a row behind.
 */

export interface WriteContext {
  readonly organizationId: string;
  /**
   * Which subject type the rows land as. Set only for a subject import, where
   * `subjects.subject_type_id` is NOT NULL and no column of the file can supply
   * it — the tenant chooses it when they start the import.
   */
  readonly subjectTypeId: string | null;
  /** The pipeline a deals import lands in, where the tenant has a default one. */
  readonly pipelineId: string | null;
}

/** A planned row, as the writer needs to read it. */
export interface PlannedValues {
  readonly values: Readonly<Record<string, string>>;
  readonly customFields: Readonly<Record<string, string>> | null;
}

/**
 * Filling the gaps in a record this file matched, and putting it back.
 *
 * Optional, and its absence is meaningful rather than a stub: an entity whose
 * match strategy is `none` can never plan an `update` row, so a writer without
 * this cannot be asked for one. The commit refuses such a row loudly instead of
 * quietly doing nothing — that combination could only arise from a plan stored
 * by older code, which is exactly when a silent no-op is worst.
 */
export interface UpdatePath {
  /** The record as it is now, kept as the before-image the undo replays. */
  before(
    tx: TenantTx,
    context: WriteContext,
    recordId: string,
  ): Promise<Record<string, unknown> | null>;

  /**
   * Fills blanks only.
   *
   * An import is somebody else's export, and overwriting a value a person
   * curated here with a staler one from another system is the complaint this
   * avoids.
   */
  fillGaps(
    tx: TenantTx,
    context: WriteContext,
    recordId: string,
    before: Record<string, unknown>,
    row: PlannedValues,
  ): Promise<void>;

  /**
   * Puts back exactly what was replaced.
   *
   * Replayed from the before-image rather than worked out from the current
   * state: inspecting what is there cannot tell a value the import filled from
   * one a person edited afterwards, and would silently discard the edit.
   */
  restore(
    tx: TenantTx,
    context: WriteContext,
    recordId: string,
    before: Record<string, unknown>,
  ): Promise<void>;
}

export interface EntityWriter {
  /** Creates the record this row describes, and returns its identifier. */
  create(tx: TenantTx, context: WriteContext, row: PlannedValues): Promise<string>;

  /**
   * Takes back what `create` wrote.
   *
   * Soft, as everywhere else: the record leaves the product without leaving the
   * database, so a wrong undo is itself recoverable.
   */
  remove(tx: TenantTx, context: WriteContext, recordId: string): Promise<void>;

  readonly updates?: UpdatePath;
}

/**
 * What an import needs before it can be started at all.
 *
 * Answered by the writer because the writer is what would fail without it, and
 * a refusal at preview time is a sentence the tenant can act on rather than a
 * NOT NULL violation on row four thousand.
 */
export function requiresSubjectType(entity: ImportEntity): boolean {
  return entity === "subject";
}
