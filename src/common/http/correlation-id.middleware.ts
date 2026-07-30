import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const CORRELATION_HEADER = "x-correlation-id";
const REQUEST_ID_HEADER = "x-request-id";

export type RequestWithCorrelation = Request & {
  correlationId?: string;
  requestId?: string;
};

export function correlationIdMiddleware(
  req: RequestWithCorrelation,
  res: Response,
  next: NextFunction,
): void {
  const incoming =
    (typeof req.headers[CORRELATION_HEADER] === "string" && req.headers[CORRELATION_HEADER]) ||
    (typeof req.headers[REQUEST_ID_HEADER] === "string" && req.headers[REQUEST_ID_HEADER]) ||
    randomUUID();

  const correlationId = String(incoming).slice(0, 64);
  req.correlationId = correlationId;
  req.requestId = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  res.setHeader(REQUEST_ID_HEADER, correlationId);
  next();
}
