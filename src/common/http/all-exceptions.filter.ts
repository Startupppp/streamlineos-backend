import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../logger/logger.service";
import { reportError } from "../observability/error-reporter";
import { sqlstateOf } from "../observability/error-classification";
import { isTransientDbError } from "../db/transient-error";
import { isRecord } from "../types/is-record";
import type { RequestWithCorrelation } from "./correlation-id.middleware";

type ApiErrorEnvelope = {
  code: string;
  message: string;
  details?: unknown;
  correlationId?: string;
};

function defaultCode(status: number): string {
  const codeByStatus: Partial<Record<number, string>> = {
    [HttpStatus.BAD_REQUEST]: "BAD_REQUEST",
    [HttpStatus.UNAUTHORIZED]: "UNAUTHORIZED",
    [HttpStatus.PAYMENT_REQUIRED]: "PAYMENT_REQUIRED",
    [HttpStatus.FORBIDDEN]: "FORBIDDEN",
    [HttpStatus.NOT_FOUND]: "NOT_FOUND",
    [HttpStatus.CONFLICT]: "CONFLICT",
    [HttpStatus.PAYLOAD_TOO_LARGE]: "PAYLOAD_TOO_LARGE",
    [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: "UNSUPPORTED_MEDIA_TYPE",
    [HttpStatus.UNPROCESSABLE_ENTITY]: "UNPROCESSABLE_ENTITY",
    [HttpStatus.TOO_MANY_REQUESTS]: "RATE_LIMITED",
    [HttpStatus.SERVICE_UNAVAILABLE]: "SERVICE_UNAVAILABLE",
  };
  return codeByStatus[status] ?? `HTTP_${status}`;
}

function messageFromHttpBody(body: string | Record<string, unknown>): string {
  if (typeof body === "string") return body;
  if (typeof body.message === "string" && body.message.trim()) {
    return body.message;
  }
  if (Array.isArray(body.message)) {
    const messages = body.message.filter(
      (message): message is string =>
        typeof message === "string" && !!message.trim(),
    );
    if (messages.length > 0) return messages.join("; ");
  }
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  return "The request could not be completed.";
}

function httpErrorEnvelope(
  status: number,
  body: string | Record<string, unknown>,
): ApiErrorEnvelope {
  if (typeof body === "string") {
    return { code: defaultCode(status), message: body };
  }
  return {
    code: typeof body.code === "string" ? body.code : defaultCode(status),
    message: messageFromHttpBody(body),
    ...(body.details !== undefined ? { details: body.details } : {}),
  };
}

const BODY_PARSER_STATUS: Partial<Record<string, number>> = {
  "entity.too.large": HttpStatus.PAYLOAD_TOO_LARGE,
  "parameters.too.many": HttpStatus.PAYLOAD_TOO_LARGE,
  "entity.parse.failed": HttpStatus.BAD_REQUEST,
  "entity.verify.failed": HttpStatus.BAD_REQUEST,
  "request.aborted": HttpStatus.BAD_REQUEST,
  "request.size.invalid": HttpStatus.BAD_REQUEST,
  "encoding.unsupported": HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  "charset.unsupported": HttpStatus.UNSUPPORTED_MEDIA_TYPE,
};

const BODY_PARSER_MESSAGE: Partial<Record<number, string>> = {
  [HttpStatus.PAYLOAD_TOO_LARGE]: "The request payload is too large.",
  [HttpStatus.BAD_REQUEST]: "The request body could not be read.",
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: "That request encoding isn't supported.",
};

function bodyParserFailure(
  exception: unknown,
): (ApiErrorEnvelope & { status: number }) | null {
  if (typeof exception !== "object" || exception === null) return null;
  if (!("type" in exception)) return null;
  const type = Reflect.get(exception, "type");
  if (typeof type !== "string") return null;
  const status = BODY_PARSER_STATUS[type];
  if (status === undefined) return null;
  return {
    status,
    code: defaultCode(status),
    message:
      BODY_PARSER_MESSAGE[status] ?? "The request could not be completed.",
  };
}

function describeUnhandled(exception: unknown): Record<string, unknown> {
  if (!(exception instanceof Error)) return { message: String(exception) };
  const record = exception as Error & Record<string, unknown>;
  const detail = record["detail"];
  const hint = record["hint"];
  const query = record["query"];
  const column = record["column_name"];
  const table = record["table_name"];
  // `detail`, `hint` and `query` quote the offending row — a unique violation sets
  // detail to `Key (email)=(ada@example.com) already exists.` — so they are grouped
  // under one key the redactor withholds. Table, column and SQLSTATE carry no row
  // data and stay readable, which is what makes the redaction survivable.
  const driverDetail: Record<string, unknown> = {
    ...(typeof detail === "string" ? { detail } : {}),
    ...(typeof hint === "string" ? { hint } : {}),
    ...(typeof query === "string" ? { query } : {}),
  };

  // The SQLSTATE is on `code`, usually one or two `cause` links down under
  // Drizzle's wrapper, and never in the message — so without lifting it here a
  // missing tenant GUC (42501) is indistinguishable from any other 500.
  const sqlstate = sqlstateOf(exception);

  return {
    message: exception.message,
    stack: exception.stack,
    ...(sqlstate !== undefined ? { sqlstate } : {}),
    ...(typeof column === "string" ? { column } : {}),
    ...(typeof table === "string" ? { table } : {}),
    ...(Object.keys(driverDetail).length > 0 ? { driverDetail } : {}),
  };
}

function writeEnvelope(
  res: Response,
  status: number,
  body: ApiErrorEnvelope,
): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.status(status).json(body);
}

function retryAfterSecondsOf(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined;
  const candidate = body.retryAfterSecs;
  if (typeof candidate !== "number") return undefined;
  if (!Number.isFinite(candidate) || candidate < 0) return undefined;
  return Math.ceil(candidate);
}

function correlationIdOf(host: ArgumentsHost): string | undefined {
  try {
    return host.switchToHttp().getRequest<RequestWithCorrelation>()
      .correlationId;
  } catch {
    return undefined;
  }
}

/**
 * The path, never the query string.
 *
 * A query string is caller-supplied tenant content — a search term, a filter on
 * an email address, a date range someone chose — and putting it on every 500 log
 * line and error report carries tenant DATA where only tenant CONTEXT belongs.
 * The parameter *names* are the route's own contract rather than the tenant's
 * content, so they are kept: which filters were in play is usually the whole
 * diagnostic value, and the values almost never are.
 */
function describeRequest(host: ArgumentsHost): Record<string, unknown> {
  try {
    const req = host.switchToHttp().getRequest<Request>();
    const [path = "", queryString] = req.url.split("?", 2);
    const queryKeys =
      queryString === undefined || queryString === ""
        ? []
        : [...new URLSearchParams(queryString).keys()];
    return {
      method: req.method,
      url: path,
      ...(queryKeys.length > 0 ? { queryKeys } : {}),
    };
  } catch {
    return {};
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const correlationId = correlationIdOf(host);
    const cid = correlationId !== undefined ? { correlationId } : {};

    if (exception instanceof ZodError) {
      const details = exception.issues.map((issue) => ({
        path: issue.path.length ? issue.path.join(".") : "body",
        message: issue.message,
      }));
      writeEnvelope(res, HttpStatus.BAD_REQUEST, {
        code: "VALIDATION_FAILED",
        message: "Validation failed.",
        details,
        ...cid,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        const request = describeRequest(host);
        logger.error("Server-side HttpException", {
          status,
          ...describeUnhandled(exception),
          request,
        });
        if (!isHealthProbe(request)) reportError(exception, request);
      }

      if (status === HttpStatus.TOO_MANY_REQUESTS && !res.headersSent) {
        const retryAfter = retryAfterSecondsOf(body);
        if (retryAfter !== undefined) {
          res.setHeader("Retry-After", String(retryAfter));
        }
      }

      writeEnvelope(res, status, {
        ...httpErrorEnvelope(status, body as string | Record<string, unknown>),
        ...cid,
      });
      return;
    }

    const parserFailure = bodyParserFailure(exception);
    if (parserFailure) {
      const { status, ...envelope } = parserFailure;
      logger.warn("Rejected an unreadable request body", {
        code: envelope.code,
        request: describeRequest(host),
      });
      writeEnvelope(res, status, { ...envelope, ...cid });
      return;
    }

    if (isTransientDbError(exception)) {
      logger.warn("Transient database connection error — returning 503", {
        error:
          exception instanceof Error ? exception.message : String(exception),
      });
      writeEnvelope(res, HttpStatus.SERVICE_UNAVAILABLE, {
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily unavailable. Please try again.",
        ...cid,
      });
      return;
    }

    const request = describeRequest(host);

    logger.error("Unhandled exception", {
      ...describeUnhandled(exception),
      request,
    });

    if (!isHealthProbe(request)) reportError(exception, request);
    writeEnvelope(res, HttpStatus.INTERNAL_SERVER_ERROR, {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      ...cid,
    });
  }
}

function isHealthProbe(request: unknown): boolean {
  const url = (request as { url?: unknown } | null)?.url;
  if (typeof url !== "string") return false;
  const path = url.split("?")[0] ?? "";
  return path === "/health" || path.startsWith("/health/");
}
