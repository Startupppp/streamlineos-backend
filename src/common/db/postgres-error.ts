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
 *
 * The constraint name is read from **both** spellings on purpose. This repo
 * connects through `postgres` (postgres-js), whose error object maps the
 * server's `n` field to `constraint_name`; `pg` calls the same field
 * `constraint`. Reading only `constraint` — as this helper originally did —
 * returned `undefined` for every error the driver in use can actually produce,
 * so a caller branching on the constraint name silently took its fallback
 * branch forever. That is the same failure as reading `.code` off the wrapper:
 * a value that is never present reads as a condition that never happens. When
 * a driver sends both, node-postgres's `constraint` is the one reported.
 *
 * (`node_modules/postgres/src/connection.js:46`, error field code 110 — 'n'.)
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
        constraint: readString(current, "constraint", "constraint_name"),
        table: readString(current, "table_name", "table"),
        column: readString(current, "column_name", "column"),
        detail: readString(current, "detail"),
      };
    }
    current = Reflect.get(current, "cause");
  }

  return {};
}

export function getPostgresErrorCode(error: unknown): string | undefined {
  return getPostgresErrorDetails(error).code;
}

/**
 * The predicates below were, until this commit, a SECOND implementation of the
 * walk above, living in `postgres-errors.ts` — the same directory, one letter
 * apart in the filename — plus a THIRD private copy inside
 * `inventory/products/inv-product-crud.service.ts`.
 *
 * The plural file's own docblock explained that 53 of 63 files handling `23505`
 * never mention `cause`, and concluded "the reason it spread is that there was
 * nowhere shared to put it". There was: this file, with twelve callers, sitting
 * next to it. Two answers to one question is how the next `err.code === "23505"`
 * gets written, so there is now one walk and these read off it.
 */
function isSqlstate(error: unknown, sqlstate: string): boolean {
  return getPostgresErrorCode(error) === sqlstate;
}

/** 23505 — a unique constraint was violated. Answer with 409, never 500. */
export function isUniqueViolation(error: unknown): boolean {
  return isSqlstate(error, PG_UNIQUE_VIOLATION);
}

/** 23503 — a foreign key was violated: the row it points at is missing, or in use. */
export function isForeignKeyViolation(error: unknown): boolean {
  return isSqlstate(error, PG_FOREIGN_KEY_VIOLATION);
}

/** 23502 — a NOT NULL column was given no value. */
export function isNotNullViolation(error: unknown): boolean {
  return isSqlstate(error, PG_NOT_NULL_VIOLATION);
}

/** 23514 — a CHECK constraint refused the row. */
export function isCheckViolation(error: unknown): boolean {
  return isSqlstate(error, PG_CHECK_VIOLATION);
}

/**
 * 23P01 — an EXCLUSION constraint refused the row.
 *
 * The one people forget, and the one that most needs a 409 rather than a 500:
 * it is how overlapping ranges are rejected — a dock appointment booked over
 * another, a worker engagement overlapping an existing one — so the caller's
 * next move is to pick a different time, not to retry.
 */
export function isExclusionViolation(error: unknown): boolean {
  return isSqlstate(error, PG_EXCLUSION_VIOLATION);
}

/** 42P01 — the relation does not exist. */
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

/**
 * The driver's own account of a failure, for an OPERATOR-FACING log or record.
 *
 * `getPostgresErrorDetails` above answers "which constraint, so I can pick an
 * HTTP status". This answers "what actually went wrong", which is a different
 * question and needs different fields: the wrapper's message says
 * `Failed query: insert into "business_parties" (…60 columns…)` and names no
 * cause at all, because the SQLSTATE, the constraint and PostgreSQL's own
 * sentence are all one level down on `.cause`.
 *
 * **`detail` is deliberately not read.** On a unique violation PostgreSQL puts
 * the offending row in it -- `Key (email)=(someone@example.com) already exists`
 * -- and this string is persisted. `message`, `code`, `constraint`, `table` and
 * `column` name the FAULT; `detail` names the ROW, and an operator diagnosing a
 * dead-lettered run needs the first and not the second.
 *
 * Returns null when nothing beneath the wrapper looks like a driver error, so a
 * caller can leave an ordinary failure's text exactly as it was.
 */
export function describeDatabaseCause(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (
    let depth = 0;
    current !== null && typeof current === "object" && depth < MAX_CAUSE_DEPTH && !seen.has(current);
    depth += 1
  ) {
    seen.add(current);
    const candidate = current as Record<string, unknown>;

    // A driver error is the one carrying a SQLSTATE. The wrapper has none, which
    // is exactly why reading `.code` off it has been dead everywhere.
    if (typeof candidate["code"] === "string" && SQLSTATE_SHAPE.test(candidate["code"])) {
      const parts = [`sqlstate ${candidate["code"]}`];
      for (const field of ["message", "constraint", "constraint_name", "table", "column", "routine"]) {
        const value = candidate[field];
        if (typeof value === "string" && value.length > 0) {
          /* `constraint_name` is postgres-js's spelling of `pg`'s `constraint`; report one name. */
          parts.push(`${field === "constraint_name" ? "constraint" : field}: ${value}`);
        }
      }
      return parts.join(" | ");
    }

    current = candidate["cause"];
  }

  return null;
}
