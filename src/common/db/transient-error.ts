/**
 * Detects transient database connection errors (Neon serverless compute
 * suspend/resume, dropped sockets, brief network blips) so callers can retry
 * or degrade gracefully instead of treating them as hard failures.
 *
 * The underlying socket error (`ECONNRESET` / `errno: -4077`) is usually nested
 * under a Drizzle "Failed query" error's `.cause`, so we walk the cause chain.
 */
const TRANSIENT_CODES = new Set<string>([
  // Node socket / DNS errors
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  // postgres.js connection lifecycle codes
  "CONNECTION_ENDED",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
  // Postgres server-side connection SQLSTATEs
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

const TRANSIENT_MESSAGE_FRAGMENTS = [
  "econnreset",
  "connection terminated",
  "connection closed",
  "connection ended",
  "connection_ended",
  "terminating connection",
  "the database system is starting up",
  "the database system is shutting down",
  "server closed the connection",
];

export function isTransientDbError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 6; depth += 1) {
    const e = current as {
      code?: unknown;
      errno?: unknown;
      message?: unknown;
      cause?: unknown;
    };

    if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
    if (typeof e.errno === "number" && (e.errno === -4077 || e.errno === -4095)) return true;

    if (typeof e.message === "string") {
      const msg = e.message.toLowerCase();
      if (TRANSIENT_MESSAGE_FRAGMENTS.some((fragment) => msg.includes(fragment))) return true;
    }

    current = e.cause;
  }
  return false;
}
