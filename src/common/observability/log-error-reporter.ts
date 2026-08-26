import type { ErrorReport, ErrorReporter } from "./error-reporter";
import { redact, truncateForLog } from "./redact";

/**
 * The reporting adapter for a deployment that runs no third-party error
 * tracker. It writes one structured JSON line per reported error to stderr, so
 * an operator can query errors out of the log stream the platform already
 * collects.
 *
 * Wire at boot: `setErrorReporter(new LogErrorReporter())` in `main.ts`.
 * Without that call the port holds its noop default and nothing is reported.
 *
 * stderr directly rather than the Nest logger: this runs from the global
 * exception filter, and routing an error report back through the logger that
 * may itself be the thing failing costs the report exactly when it matters.
 *
 * The cause chain is walked to a fixed depth. An error whose cause loops would
 * otherwise recurse until the stack gives out, inside the handler that exists
 * to keep a failure from becoming a crash.
 */
const MAX_CAUSE_DEPTH = 3;

function describe(error: unknown, depth = 0): unknown {
  if (depth > MAX_CAUSE_DEPTH) return "[cause chain truncated]";
  if (!(error instanceof Error)) return truncateForLog(String(error));
  return {
    name: error.name,
    message: truncateForLog(error.message),
    ...(error.stack !== undefined ? { stack: truncateForLog(error.stack) } : {}),
    ...(error.cause !== undefined ? { cause: describe(error.cause, depth + 1) } : {}),
  };
}

export class LogErrorReporter implements ErrorReporter {
  report(report: ErrorReport): void {
    const { context } = report;
    process.stderr.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        message: "ERROR_REPORT",
        correlationId: context?.correlationId,
        orgId: context?.orgId,
        actorId: context?.actorId,
        method: context?.method,
        route: context?.route,
        error: describe(report.error),
        ...(report.extra !== undefined ? { extra: redact(report.extra) } : {}),
      }) + "\n",
    );
  }
}
