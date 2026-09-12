/**
 * Reading a Postgres error through drizzle.
 *
 * Drizzle wraps driver failures in a `DrizzleQueryError` whose `message` is the
 * SQL, and hangs the real `postgres` error off `cause`. Reading `error.code`
 * directly therefore finds `undefined`, a unique violation looks like an
 * unhandled 500, and the 409 the schema went to the trouble of guaranteeing
 * never reaches the caller. Unwrap the chain instead.
 */
export const UNIQUE_VIOLATION = "23505";

export interface PgErrorDetail {
  code: string;
  constraintName: string;
  detail: string;
}

/** The first link in the cause chain that looks like a Postgres error. */
export function pgErrorOf(error: unknown, depth = 5): PgErrorDetail | null {
  let current: unknown = error;
  for (let i = 0; i <= depth && current; i++) {
    const candidate = current as { code?: unknown; constraint_name?: unknown; detail?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        constraintName: typeof candidate.constraint_name === "string" ? candidate.constraint_name : "",
        detail: typeof candidate.detail === "string" ? candidate.detail : "",
      };
    }
    current = candidate.cause;
  }
  return null;
}

/** True for a `23505`, optionally only for one named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = pgErrorOf(error);
  if (!pg || pg.code !== UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  return pg.constraintName.includes(constraint) || pg.detail.includes(constraint);
}

/** The constraint that fired, for a message that names the real problem. */
export function violatedConstraint(error: unknown): string {
  return pgErrorOf(error)?.constraintName ?? "";
}
