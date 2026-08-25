/**
 * Reading a Postgres error through Drizzle.
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError`, so `error.code` on the
 * thing you catch is `undefined` and a naive `code === "23505"` check silently
 * never fires — which turns an ordinary duplicate into a 500. The real driver
 * error is on `cause`, sometimes a level or two down, so unwrap before asking.
 *
 * This matters most on the idempotency race in `LedgerService.post`: without
 * unwrapping, a genuine double-submit that loses the insert race surfaces as a
 * server error instead of returning the journal the winner just posted.
 */

interface PgErrorLike {
  code?: string;
  constraint_name?: string;
  detail?: string;
  message?: string;
}

const UNIQUE_VIOLATION = "23505";

/** The innermost error that actually carries a SQLSTATE, or null. */
export function pgErrorOf(error: unknown): PgErrorLike | null {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 6; depth += 1) {
    const candidate = current as PgErrorLike & { cause?: unknown };
    if (typeof candidate.code === "string" && candidate.code.length > 0) return candidate;
    current = candidate.cause;
  }
  return null;
}

/**
 * A unique-constraint violation, optionally on one named index.
 *
 * The constraint name is matched against `constraint_name` first — the field
 * postgres-js populates — and then against the message text, so a driver that
 * only renders the name into the message is still recognised.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = pgErrorOf(error);
  if (pg?.code !== UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  return (
    (pg.constraint_name ?? "").includes(constraint) ||
    (pg.detail ?? "").includes(constraint) ||
    (pg.message ?? "").includes(constraint) ||
    (error instanceof Error ? error.message.includes(constraint) : false)
  );
}
