import { logger } from "./logger.service";

/**
 * A fire-and-forget side effect stays fire-and-forget — but it stops being
 * invisible. `.catch(() => undefined)` is the shape that made a realtime outage
 * produce no log line at all.
 *
 * The cause chain matters more than the message: an SDK or driver error's own
 * message is frequently useless on its own, and the root is one or two `cause`
 * levels down.
 */
export function logSideEffectFailure(
  what: string,
  detail?: Record<string, unknown>,
): (err: unknown) => void {
  return (err: unknown) => {
    logger.warn(`${what} failed`, {
      ...detail,
      cause: describeCause(err),
    });
  };
}

function describeCause(err: unknown, depth = 0): unknown {
  if (depth > 3) return "[cause chain truncated]";
  if (!(err instanceof Error)) return String(err);
  return {
    message: err.message,
    /**
     * An `AggregateError` keeps its members on `errors`, not `cause`, so a
     * fan-out that reported "failed for 3 subscription(s)" and nothing else was
     * the same invisibility one level down: the summary names a count and never
     * says what went wrong.
     */
    ...(err instanceof AggregateError
      ? { errors: err.errors.map((inner: unknown) => describeCause(inner, depth + 1)) }
      : {}),
    ...(err.cause !== undefined ? { cause: describeCause(err.cause, depth + 1) } : {}),
  };
}
