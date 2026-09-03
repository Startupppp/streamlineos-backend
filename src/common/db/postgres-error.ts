import { sqlstateOf } from "../observability/error-classification";

/**
 * The single place SQLSTATE classification happens.
 *
 * Measured against postgres-js 3.4 + drizzle-orm 0.45.2: every query issued
 * through Drizzle — `.insert()`, `.update()`, `db.execute()`, and the same
 * inside a transaction — rejects with a `DrizzleQueryError` whose own keys are
 * `stack, message, query, params, cause`. It carries **no `code`**, and its
 * message is `Failed query: <sql>\nparams: <params>`, which contains neither
 * the SQLSTATE nor the driver's message. Reading `err.code` or grepping
 * `err.message` for "23505" is therefore false for every real database error.
 * The `PostgresError` sits one `cause` link down, and it names its fields
 * `constraint_name` / `table_name` / `column_name` — not `constraint` /
 * `table` / `column`, which is what node-postgres uses.
 */
export const PG_UNIQUE_VIOLATION = "23505";
export const PG_RESTRICT_VIOLATION = "23001";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_NOT_NULL_VIOLATION = "23502";
export const PG_CHECK_VIOLATION = "23514";
export const PG_EXCLUSION_VIOLATION = "23P01";
export const PG_UNDEFINED_TABLE = "42P01";

export type PostgresErrorDetails = {
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
  detail?: string;
};

const MAX_CAUSE_DEPTH = 6;
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;

function readString(source: object, ...names: string[]): string | undefined {
  for (const name of names) {
    const value: unknown = Reflect.get(source, name);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Walks the bounded cause chain to the driver error carrying the SQLSTATE and
 * reads the constraint, relation and column off that same object, so a caller
 * never pairs a code from one link with a constraint from another.
 */
export function getPostgresErrorDetails(error: unknown): PostgresErrorDetails {
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (
    let depth = 0;
    current !== null && typeof current === "object" && depth < MAX_CAUSE_DEPTH && !seen.has(current);
    depth += 1
  ) {
    seen.add(current);
    const code = readString(current, "code");
    if (code !== undefined && SQLSTATE_SHAPE.test(code)) {
      return {
        code,
        constraint: readString(current, "constraint_name", "constraint"),
        table: readString(current, "table_name", "table"),
        column: readString(current, "column_name", "column"),
        detail: readString(current, "detail"),
      };
    }
    current = Reflect.get(current, "cause");
  }

  return {};
}

function isSqlstate(error: unknown, sqlstate: string): boolean {
  return sqlstateOf(error) === sqlstate;
}

export function isUniqueViolation(error: unknown): boolean {
  return isSqlstate(error, PG_UNIQUE_VIOLATION);
}

export function isForeignKeyViolation(error: unknown): boolean {
  return isSqlstate(error, PG_FOREIGN_KEY_VIOLATION);
}

export function isNotNullViolation(error: unknown): boolean {
  return isSqlstate(error, PG_NOT_NULL_VIOLATION);
}

export function isCheckViolation(error: unknown): boolean {
  return isSqlstate(error, PG_CHECK_VIOLATION);
}

export function isExclusionViolation(error: unknown): boolean {
  return isSqlstate(error, PG_EXCLUSION_VIOLATION);
}

export function isUndefinedTable(error: unknown): boolean {
  return isSqlstate(error, PG_UNDEFINED_TABLE);
}

/**
 * True only when the error is a unique violation raised by one of the named
 * constraints or unique indexes. Postgres reports a bare unique index under its
 * index name, so both forms are matched by the same call.
 */
export function isUniqueViolationOn(error: unknown, ...constraints: string[]): boolean {
  const details = getPostgresErrorDetails(error);
  if (details.code !== PG_UNIQUE_VIOLATION) return false;
  return details.constraint !== undefined && constraints.includes(details.constraint);
}
