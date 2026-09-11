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
 * The constraint name is read from **both** spellings on purpose. This repo
 * connects through `postgres` (postgres-js), whose error object maps the
 * server's `n` field to `constraint_name`; `pg` calls the same field
 * `constraint`. Reading only `constraint` — as this helper originally did —
 * returned `undefined` for every error the driver in use can actually produce,
 * so a caller branching on the constraint name silently took its fallback
 * branch forever. That is the same failure as reading `.code` off the wrapper:
 * a value that is never present reads as a condition that never happens.
 *
 * (`node_modules/postgres/src/connection.js:46`, error field code 110 — 'n'.)
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
      if (typeof candidate.constraint === "string") {
        constraint = candidate.constraint;
      } else if (typeof candidate.constraint_name === "string") {
        constraint = candidate.constraint_name;
      }
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
    current !== null && typeof current === "object" && depth < 6 && !seen.has(current);
    depth += 1
  ) {
    seen.add(current);
    const candidate = current as Record<string, unknown>;

    // A driver error is the one carrying a SQLSTATE. The wrapper has none, which
    // is exactly why reading `.code` off it has been dead everywhere.
    if (typeof candidate["code"] === "string" && /^[0-9A-Z]{5}$/.test(candidate["code"])) {
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
