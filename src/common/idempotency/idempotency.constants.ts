/** Reflector metadata key carrying the command name for a fenced endpoint. */
export const IDEMPOTENCY_COMMAND = "idempotency_command";

/** How long a single in-flight attempt holds its lease before it may be reclaimed. */
export const IDEMPOTENCY_LEASE_MS = 60_000;

/** How long a completed fence record is retained for replay before it expires. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
