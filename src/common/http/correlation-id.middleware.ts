import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { runWithObservabilityContext } from "../observability/observability-context";

const CORRELATION_HEADER = "x-correlation-id";
const REQUEST_ID_HEADER = "x-request-id";
const MAX_LENGTH = 64;

export type RequestWithCorrelation = Request & {
  correlationId?: string;
  requestId?: string;
};

/**
 * A caller-supplied correlation id is untrusted input that ends up on every log
 * line for the request, so it is treated as hostile.
 *
 * Two steps. Take only the leading run up to the first whitespace, which stops a
 * value carrying a newline and a JSON fragment from fabricating what looks like a
 * separate, entirely convincing log record. Then keep only characters that cannot
 * forge log structure at all, and cap the length so one header cannot bloat every
 * line a request produces.
 */
function sanitise(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const leading = raw.split(/\s/)[0] ?? "";
  const safe = leading.replace(/[^A-Za-z0-9._-]/g, "").slice(0, MAX_LENGTH);
  return safe.length > 0 ? safe : undefined;
}

export function correlationIdMiddleware(
  req: RequestWithCorrelation,
  res: Response,
  next: NextFunction,
): void {
  const correlationId =
    sanitise(req.headers[CORRELATION_HEADER]) ??
    sanitise(req.headers[REQUEST_ID_HEADER]) ??
    randomUUID();

  req.correlationId = correlationId;
  req.requestId = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  res.setHeader(REQUEST_ID_HEADER, correlationId);

  // Establishing the ambient context here, rather than in a second middleware,
  // keeps one id per request: two middlewares would each mint their own, and the
  // id on the response would not be the id in the logs.
  runWithObservabilityContext(
    { correlationId, method: req.method, route: req.path },
    () => next(),
  );
}
