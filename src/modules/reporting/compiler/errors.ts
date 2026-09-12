/**
 * Why compilation refused.
 *
 * Every refusal is a *code*, not a message, because the codes are the closed set
 * this compiler's safety argument rests on: if a description does not compile,
 * it failed one of these named checks rather than falling through to an emit
 * path nobody enumerated. The adversarial specs assert on `code`, so a refusal
 * that silently changed shape would fail the suite instead of quietly becoming a
 * different refusal — or worse, stopping being one.
 *
 * `unsafe_identifier` is deliberately in here even though a caller cannot reach
 * it. Caller input never becomes an identifier — names are looked up in the
 * registry and the registry's own string is emitted — so the only way to trip it
 * is for somebody to add a registry entry with a name that is not a plain
 * lowercase identifier. That is a build-time mistake, and this is what turns it
 * into a loud one rather than an injected one.
 */
export type QueryCompilationErrorCode =
  /** The registry has no source under that name. */
  | "unknown_source"
  /** The source has no such field, or the join prefix is not declared on it. */
  | "unknown_field"
  /** The operator is not one of the enumerated comparisons. */
  | "unknown_operator"
  /** The aggregate is not one of the enumerated aggregates. */
  | "unknown_aggregate"
  /** The operator exists but means nothing for that field's type. */
  | "operator_type_mismatch"
  /** The value is not the shape the operator and field type require. */
  | "value_type_mismatch"
  /** A grouped query whose projection Postgres would reject. */
  | "invalid_grouping"
  /** `orderBy` names a projection index that is not being projected. */
  | "invalid_order_target"
  /** The description is bigger than the compiler will emit for. */
  | "limit_exceeded"
  /** The description is structurally malformed — missing or wrong-typed parts. */
  | "malformed_description"
  /** A registry entry carries a name that must never be emitted. */
  | "unsafe_identifier";

/**
 * A refusal to compile.
 *
 * Thrown, not returned, because there is no partial success worth handing back:
 * a description either compiles to parameterised SQL in full or produces no SQL
 * at all. A compiler that returned `{ sql, warnings }` would eventually have a
 * caller that ignored the warnings.
 */
export class QueryCompilationError extends Error {
  constructor(
    readonly code: QueryCompilationErrorCode,
    message: string,
    /** Where in the description the refusal happened, for the caller's benefit. */
    readonly path?: string,
  ) {
    super(path ? `${message} (at ${path})` : message);
    this.name = "QueryCompilationError";
  }
}
