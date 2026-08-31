/**
 * Pulls the Postgres SQLSTATE out of an error so a report says which failure
 * class it is, not just that something threw.
 *
 * This exists because of one specific incident shape. `app.current_org_id()`
 * raises `42501` when the tenant GUC is absent, so every query that reaches the
 * pool without a tenant context fails with it — the failure that emptied
 * `notifications` platform-wide. The SQLSTATE lives on the error's `code`
 * property and never in its message (postgres-js builds the message from the
 * server's message text alone), and Drizzle wraps the driver error, so the code
 * is usually one or two `cause` links down. An alert grepping the log stream
 * for "42501" therefore finds nothing unless the code is lifted out explicitly.
 */
const MAX_CAUSE_DEPTH = 6;

/** `insufficient_privilege` — raised by every RLS policy when the tenant GUC is absent. */
export const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";

/** A SQLSTATE is five alphanumerics; matching the shape keeps Node's `ECONNRESET` out. */
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;

export function sqlstateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && SQLSTATE_SHAPE.test(candidate.code)) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

export function isTenantContextError(error: unknown): boolean {
  return sqlstateOf(error) === SQLSTATE_INSUFFICIENT_PRIVILEGE;
}
