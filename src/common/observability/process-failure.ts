import { logger } from "../logger/logger.service";
import { reportError } from "./error-reporter";

export type ProcessFailureKind = "uncaughtException" | "unhandledRejection";

export interface ProcessFailureTarget {
  on(kind: ProcessFailureKind, listener: (value: unknown) => void): unknown;
}

export function describeFailure(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return `${typeof value}: ${JSON.stringify(value)}`;
  } catch {
    return String(value);
  }
}

const MESSAGES: Record<ProcessFailureKind, string> = {
  uncaughtException: "Uncaught exception — shutting down, process state is no longer trustworthy",
  unhandledRejection: "Unhandled promise rejection — process kept alive",
};

export const FATAL_EXIT_CODE = 1;
export const LOG_FLUSH_MS = 100;

const installed = new WeakSet<ProcessFailureTarget>();

function record(kind: ProcessFailureKind, value: unknown): void {
  logger.error(MESSAGES[kind], { error: describeFailure(value) });
  reportError(value, { source: kind });
}

function exitAfterFlush(): void {
  setTimeout(() => process.exit(FATAL_EXIT_CODE), LOG_FLUSH_MS).unref();
}

let fatalHandler: () => void = exitAfterFlush;
let handling = false;

export function setFatalHandler(handler: () => void): void {
  fatalHandler = handler;
}

export function resetFatalHandler(): void {
  fatalHandler = exitAfterFlush;
  handling = false;
}

export function installProcessFailureHandlers(
  target: ProcessFailureTarget = process,
): void {
  if (installed.has(target)) return;
  installed.add(target);

  target.on("uncaughtException", (value) => {
    record("uncaughtException", value);
    if (handling) return;
    handling = true;
    fatalHandler();
  });
  target.on("unhandledRejection", (value) => {
    record("unhandledRejection", value);
  });
}
