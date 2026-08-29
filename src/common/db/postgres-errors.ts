/**
 * Postgres error classification that survives Drizzle's wrapper.
 *
 * Drizzle raises a `DrizzleQueryError` and hangs the driver's error off
 * `cause`, so the obvious `err.code === "23505"` reads the *wrapper's* code —
 * which is undefined — and matches nothing. Every handler written that way
 * believes it is catching a unique violation and is in fact catching none, so a
 * duplicate key reaches the client as a 500 instead of the 409 the author
 * intended.
 *
 * Found in `inv-product-crud.service.ts`, where it also silently disabled an
 * auto-SKU retry loop that depended on it. A repo-wide grep then found **53 of
 * the 63 files handling `23505` never mention `cause` at all**, so this is a
 * pattern rather than a slip — and the reason it spread is that there was
 * nowhere shared to put it.
 *
 * The chain is walked with a depth bound rather than `while`: an error whose
 * `cause` points back at itself is rare but real, and a hang inside an error
 * handler is worse than the error.
 */

const MAX_CAUSE_DEPTH = 5;

/** The SQLSTATE of `err`, or any error it wraps. */
export function postgresErrorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return null;
    if ("code" in current && typeof current.code === "string") return current.code;
    if (!("cause" in current)) return null;
    current = current.cause;
  }
  return null;
}

/** 23505 — a unique constraint was violated. Answer with 409, never 500. */
export function isUniqueViolation(err: unknown): boolean {
  return postgresErrorCode(err) === "23505";
}

/** 23503 — a foreign key was violated: the row it points at is missing or in use. */
export function isForeignKeyViolation(err: unknown): boolean {
  return postgresErrorCode(err) === "23503";
}

/** 23514 — a CHECK constraint refused the row. */
export function isCheckViolation(err: unknown): boolean {
  return postgresErrorCode(err) === "23514";
}
