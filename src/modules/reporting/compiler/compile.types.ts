import type { ParamValue } from "./emit";
import type { FieldType, Projection } from "./query-description";
import type { JoinSpec, QueryRegistry } from "./registry";
import type { RequesterScope } from "./scope";
import type { DataScope } from "../../access/access.types";

/**
 * The compiler's shapes: what goes in besides the description, and what comes
 * out. Declared here rather than in `compile.ts` so the clause compilers in
 * `lib/` can name them without importing the compiler they are part of.
 * `compile.ts` re-exports the public three, so callers import from it as before.
 */

export interface CompiledColumn {
  /** The generated output alias, `c0`, `c1`, … Never caller-derived. */
  readonly alias: string;
  /** What the caller asked for, so it can label its own column. */
  readonly projection: Projection;
  readonly type: FieldType;
}

export interface CompiledQuery {
  /** Parameterised SQL. Contains `$n` placeholders and no literals. */
  readonly text: string;
  readonly params: readonly ParamValue[];
  readonly columns: readonly CompiledColumn[];
  /** Which registry source this reads, for the audit trail and the permission check. */
  readonly source: string;
  /**
   * The scope this statement was compiled under.
   *
   * Reported back rather than left for the caller to remember, so the audit row
   * records the scope that is *in the statement* rather than a variable that was
   * in scope at the call site. Those are the same value today; they stop being
   * the same value the first time somebody adds a branch, and an audit trail
   * that disagrees with the statement beside it is worse than no column.
   */
  readonly scope: DataScope;
}

/** A field, resolved to something emittable. */
export interface ResolvedField {
  readonly alias: string;
  readonly column: string;
  readonly type: FieldType;
  /** The join this came through, if any — so the compiler knows to emit it. */
  readonly join?: JoinSpec;
}

export interface CompileContext {
  readonly organizationId: string;
  /**
   * Who is asking, and how much they may see. Required, and deliberately not
   * optional-with-a-default: an optional `requester` defaulting to `all` is the
   * same thing as a description that can omit its scope, one indirection later.
   * Every call site has to state the answer, and `none` is a statable answer.
   */
  readonly requester: RequesterScope;
  readonly registry?: QueryRegistry;
}
