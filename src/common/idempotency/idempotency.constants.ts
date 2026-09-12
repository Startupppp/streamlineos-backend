/** Reflector metadata key carrying the command name for a fenced endpoint. */
export const IDEMPOTENCY_COMMAND = "idempotency_command";

/**
 * Reflector metadata key marking a fence the caller may decline.
 *
 * Present and true means: honour an `Idempotency-Key` when one is sent, and let
 * the request through untouched when one is not. Absent means the header is
 * required, which stays the default because a command whose replay is a real
 * correctness problem should not be able to opt out of the fence by omitting a
 * header.
 */
export const IDEMPOTENCY_OPTIONAL = "idempotency_optional";

/** How long a single in-flight attempt holds its lease before it may be reclaimed. */
export const IDEMPOTENCY_LEASE_MS = 60_000;

/** How long a completed fence record is retained for replay before it expires. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
