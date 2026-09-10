export type PostgresErrorDetails = {
  code?: string;
  constraint?: string;
};

/**
 * Drizzle wraps driver errors in `DrizzleQueryError`, putting the PostgreSQL
 * SQLSTATE and constraint name on `.cause`. Walk the bounded cause chain so
 * domain services can consistently translate database constraints into safe,
 * actionable HTTP errors.
 *
 * The constraint name arrives under one of two spellings, so read both: this
 * repo drives postgres-js, which calls the field `constraint_name`
 * (`node_modules/postgres/src/connection.js:46`, error field code 110 — 'n'),
 * while `constraint` is node-postgres's name for it. Reading only `constraint`
 * meant every caller comparing a constraint name got `undefined` on every real
 * failure.
 */
export function getPostgresErrorDetails(
  error: unknown,
): PostgresErrorDetails {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let code: string | undefined;
  let constraint: string | undefined;

  for (
    let depth = 0;
    current !== null &&
    typeof current === "object" &&
    depth < 6 &&
    !seen.has(current);
    depth += 1
  ) {
    seen.add(current);
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };

    if (!code && typeof candidate.code === "string") {
      code = candidate.code;
    }
    if (!constraint) {
      const named = candidate.constraint ?? candidate.constraint_name;
      if (typeof named === "string") constraint = named;
    }
    if (code && constraint) break;
    current = candidate.cause;
  }

  return { code, constraint };
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

/** 23505 — a unique constraint was violated. Answer with 409, never 500. */
export function isUniqueViolation(error: unknown): boolean {
  return getPostgresErrorCode(error) === "23505";
}

/** 23503 — a foreign key was violated: the row it points at is missing, or in use. */
export function isForeignKeyViolation(error: unknown): boolean {
  return getPostgresErrorCode(error) === "23503";
}

/** 23514 — a CHECK constraint refused the row. */
export function isCheckViolation(error: unknown): boolean {
  return getPostgresErrorCode(error) === "23514";
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
  return getPostgresErrorCode(error) === "23P01";
}
