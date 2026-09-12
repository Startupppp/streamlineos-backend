import type { PartyFingerprint } from "../../party/party-duplicates";
import type { MappedColumn } from "./column-mapping";
import type { RowMatch } from "./import-draft";
import type { ImportEntity } from "./import-entities";

/** One definition, owned by the schema layer that stores it. */
export type { RowAction } from "../../../db/schema/crm/imports";
import type { RowAction } from "../../../db/schema/crm/imports";


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
