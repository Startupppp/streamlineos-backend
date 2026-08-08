export type PostgresErrorDetails = {
  code?: string;
  constraint?: string;
};

/**
 * Drizzle wraps driver errors in `DrizzleQueryError`, putting the PostgreSQL
 * SQLSTATE and constraint name on `.cause`. Walk the bounded cause chain so
 * domain services can consistently translate database constraints into safe,
 * actionable HTTP errors.
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
      cause?: unknown;
    };

    if (!code && typeof candidate.code === "string") {
      code = candidate.code;
    }
    if (!constraint && typeof candidate.constraint === "string") {
      constraint = candidate.constraint;
    }
    if (code && constraint) break;
    current = candidate.cause;
  }

  return { code, constraint };
}

export function getPostgresErrorCode(error: unknown): string | undefined {
  return getPostgresErrorDetails(error).code;
}
