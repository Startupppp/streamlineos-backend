import { getObservabilityContext, type ObservabilityContext } from "./observability-context";
import { redact } from "./redact";

export interface ErrorReport {
  readonly error: unknown;
  readonly context: ObservabilityContext | undefined;
  readonly extra?: Record<string, unknown>;
}

export interface ErrorReporter {
  report(report: ErrorReport): void;
}

/**
 * Reporting is a port, not a vendor. The application decides that an error is
 * worth reporting; where it goes is a deployment concern, and a self-hosted or
 * air-gapped deployment must be able to run with nothing attached.
 *
 * The default discards: the logger has already written the error, so a missing
 * tracker costs visibility in one place, never the record itself.
 */
const noopReporter: ErrorReporter = { report: () => undefined };

let active: ErrorReporter = noopReporter;

export function setErrorReporter(reporter: ErrorReporter): void {
  active = reporter;
}

export function resetErrorReporter(): void {
  active = noopReporter;
}

export function getErrorReporter(): ErrorReporter {
  return active;
}

/**
 * Never throws. An error tracker failing while reporting an error would turn a
 * handled 500 into an unhandled crash, which is the worst possible moment for it.
 */
export function reportError(error: unknown, extra?: Record<string, unknown>): void {
  try {
    active.report({
      error,
      context: getObservabilityContext(),
      ...(extra !== undefined ? { extra: redact(extra) as Record<string, unknown> } : {}),
    });
  } catch {
    // Deliberately swallowed: see above.
  }
}
