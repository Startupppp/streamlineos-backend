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
