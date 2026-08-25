import { getObservabilityContext } from "../observability/observability-context";
import { redact, truncateForLog } from "../observability/redact";

type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Read per emit rather than captured at import. A module-load snapshot cannot be
 * changed by a test, and made the threshold untestable.
 */
function threshold(): LogLevel {
  return process.env.NODE_ENV === "production" ? "warn" : "debug";
}

function emit(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVELS[level] < LEVELS[threshold()]) return;

  // Ambient identity is stamped at the top level, not inside meta, so a log
  // aggregator can index and filter on it without unpacking each record.
  const context = getObservabilityContext();

  const line =
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message: truncateForLog(message),
      ...(context?.correlationId ? { correlationId: context.correlationId } : {}),
      ...(context?.orgId ? { orgId: context.orgId } : {}),
      ...(context?.actorId ? { actorId: context.actorId } : {}),
      ...(context?.method ? { method: context.method } : {}),
      ...(context?.route ? { route: context.route } : {}),
      // Everything a caller passes is untrusted for logging purposes: it may carry
      // a token, a customer's address, or an object large enough to flood the stream.
      ...(meta !== undefined ? { meta: redact(meta) } : {}),
    }) + "\n";

  if (level === "error" || level === "warn") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const logger = {
  debug: (m: string, meta?: unknown) => emit("debug", m, meta),
  info: (m: string, meta?: unknown) => emit("info", m, meta),
  warn: (m: string, meta?: unknown) => emit("warn", m, meta),
  error: (m: string, meta?: unknown) => emit("error", m, meta),
};
