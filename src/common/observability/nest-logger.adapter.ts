import type { LoggerService } from "@nestjs/common";
import { logger } from "../logger/logger.service";

/**
 * Routes the framework's own logging through the structured logger.
 *
 * Seventy-odd modules construct a Nest `Logger`, which writes plain text to the
 * console and so carries no correlation id, no organisation, and no redaction.
 * Installing this adapter once converts all of them, rather than editing every
 * call site — and it also catches the framework's own startup and error output.
 *
 * Nest's signature is `(message, ...optionalParams)`, where the trailing string
 * is conventionally the emitting class and, for `error`, the one before it is a
 * stack. Both are recovered here so a line keeps its origin.
 */

interface Decomposed {
  message: string;
  meta?: Record<string, unknown>;
}

function renderMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message) ?? String(message);
  } catch {
    return String(message);
  }
}

function decompose(message: unknown, params: unknown[], withStack: boolean): Decomposed {
  const meta: Record<string, unknown> = {};
  const rest = [...params];
  const trailing = rest[rest.length - 1];

  // `error(message, stack)` and `error(message, context)` are both two-argument
  // calls, so position alone cannot tell them apart. A stack is multi-line and a
  // class name never is — without this check a bare `logger.error(msg, err.stack)`
  // files the whole trace under `context` and loses it for grouping.
  if (withStack && rest.length === 1 && typeof trailing === "string" && trailing.includes("\n")) {
    meta.stack = rest.pop() as string;
  } else {
    if (rest.length > 0 && typeof rest[rest.length - 1] === "string") {
      meta.context = rest.pop() as string;
    }
    if (withStack && rest.length > 0 && typeof rest[rest.length - 1] === "string") {
      meta.stack = rest.pop() as string;
    }
  }
  if (message instanceof Error) {
    meta.error = message;
  }
  if (rest.length > 0) {
    meta.params = rest;
  }

  return {
    message: renderMessage(message),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
}

function emit(
  level: "debug" | "info" | "warn" | "error",
  message: unknown,
  params: unknown[],
  withStack = false,
): void {
  const { message: text, meta } = decompose(message, params, withStack);
  logger[level](text, meta);
}

export const structuredNestLogger = {
  log: (message: unknown, ...params: unknown[]) => emit("info", message, params),
  warn: (message: unknown, ...params: unknown[]) => emit("warn", message, params),
  error: (message: unknown, ...params: unknown[]) => emit("error", message, params, true),
  debug: (message: unknown, ...params: unknown[]) => emit("debug", message, params),
  // Nest's `verbose` is below `debug`; the structured logger has no such level.
  verbose: (message: unknown, ...params: unknown[]) => emit("debug", message, params),
  fatal: (message: unknown, ...params: unknown[]) => emit("error", message, params, true),
  // `satisfies` rather than a type annotation: Nest declares debug/verbose as
  // optional, which would make them possibly-undefined at every call site.
} satisfies LoggerService;
