import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { runWithObservabilityContext } from "../observability/observability-context";
import {
  formatTraceparent,
  parseTraceparent,
  runInSpan,
  startSpan,
} from "../observability/tracing";
import type { SeamKey } from "../observability/seam-budgets";
import { PROCESS_CELL_ID } from "../cell-resources/cell-id";
import { currentRelease } from "../observability/release";
import { resolveClientIp } from "./client-ip";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function routeSeamFor(method: string): SeamKey {
  return READ_METHODS.has(method.toUpperCase()) ? "route.cached.read" : "route.write";
}

const CORRELATION_HEADER = "x-correlation-id";
const REQUEST_ID_HEADER = "x-request-id";
const TRACEPARENT_HEADER = "traceparent";
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

  /**
   * The request's span starts here and ends when the response does.
   *
   * An inbound `traceparent` is joined rather than replaced, so a request
   * arriving from another service continues that service's trace instead of
   * starting an unrelated one. The header is echoed back with this span's id,
   * which is what lets a caller stitch the two halves together.
   *
   * Started inside the observability context so the span carries the same
   * correlation id as every log line about the same request — and so deferred
   * work, which runs inside this context, nests under this span rather than
   * appearing as an orphan trace.
   */
  const clientIp = resolveClientIp(req);
  const rawUa = req.headers["user-agent"];
  const userAgent =
    typeof rawUa === "string"
      ? rawUa.slice(0, 512)
      : Array.isArray(rawUa)
        ? rawUa[0]?.slice(0, 512)
        : undefined;

  runWithObservabilityContext(
    {
      correlationId,
      method: req.method,
      route: req.path,
      cellId: PROCESS_CELL_ID,
      release: currentRelease(),
      ...(clientIp ? { clientIp } : {}),
      ...(userAgent ? { userAgent } : {}),
    },
    () => {
      const open = startSpan(`${req.method} ${req.path}`, {
        parent: parseTraceparent(req.headers[TRACEPARENT_HEADER] as string | undefined),
        attributes: { "http.method": req.method, seam: routeSeamFor(req.method) },
      });

      res.setHeader(TRACEPARENT_HEADER, formatTraceparent(open.span));

      // Both, because express emits `finish` on a completed response and `close`
      // on an aborted one; `end` ignores the second of the two.
      const done = (): void => open.end(res.statusCode >= 500 ? "error" : "ok");
      res.on("finish", done);
      res.on("close", done);

      runInSpan(open.span, () => next());
    },
  );
}
