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

/**
 * A constraint the database refused, answered as the client error it is.
 *
 * Nothing mapped SQLSTATEs here, so an uncaught unique violation fell through to
 * the final branch and the caller got a 500 INTERNAL_ERROR for a duplicate they
 * could have fixed themselves. The 400 arm reuses validation's own
 * `VALIDATION_FAILED` / `details: [{path, message}]` shape so a form can point at
 * the field whether the rejection came from Zod or from Postgres.
 */
const CONSTRAINT_FAILURE: Partial<
  Record<string, { status: number; code: string; message: string }>
> = {
  // unique_violation
  "23505": {
    status: HttpStatus.CONFLICT,
    code: "CONFLICT",
    message: "That record already exists.",
  },
  // foreign_key_violation
  "23503": {
    status: HttpStatus.BAD_REQUEST,
    code: "VALIDATION_FAILED",
    message: "Validation failed.",
  },
  // not_null_violation
  "23502": {
    status: HttpStatus.BAD_REQUEST,
    code: "VALIDATION_FAILED",
    message: "Validation failed.",
  },
};

const CONSTRAINT_DETAIL_MESSAGE: Partial<Record<string, string>> = {
  "23503": "References a record that does not exist.",
  "23502": "Required.",
};

/**
 * Reads a postgres-js diagnostic field through Drizzle's wrapper — the driver
 * error is one or two `cause` links down, and the wrapper carries none of them.
 */
function driverFieldOf(exception: unknown, field: string): string | undefined {
  let current: unknown = exception;
  for (let depth = 0; current != null && depth < 6; depth += 1) {
    const value = (current as Record<string, unknown>)[field];
    if (typeof value === "string" && value.length > 0) return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function constraintFailure(
  exception: unknown,
): (ApiErrorEnvelope & { status: number }) | null {
  const sqlstate = sqlstateOf(exception);
  if (sqlstate === undefined) return null;
  const mapped = CONSTRAINT_FAILURE[sqlstate];
  if (mapped === undefined) return null;

  const detailMessage = CONSTRAINT_DETAIL_MESSAGE[sqlstate];
  if (detailMessage === undefined) return { ...mapped };

  // 23502 names the column; 23503 names only the constraint, whose name is the
  // route's own contract rather than tenant data.
  const path =
    driverFieldOf(exception, "column_name") ??
    driverFieldOf(exception, "constraint_name") ??
    "body";
  return { ...mapped, details: [{ path, message: detailMessage }] };
}

function describeUnhandled(exception: unknown): Record<string, unknown> {
  if (!(exception instanceof Error)) return { message: String(exception) };
  const record = exception as Error & Record<string, unknown>;
  const detail = record["detail"];
  const hint = record["hint"];
  const query = record["query"];
  const column = record["column_name"];
  const table = record["table_name"];
  const driverDetail: Record<string, unknown> = {
    ...(typeof detail === "string" ? { detail } : {}),
    ...(typeof hint === "string" ? { hint } : {}),
    ...(typeof query === "string" ? { query } : {}),
  };

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

const BEARER_PATH_PREFIXES = ["/public/wiki/"];
const VERSION_PREFIX = /^\/v\d+(?=\/)/;

function redactBearerPathSegment(path: string): string {
  const version = VERSION_PREFIX.exec(path)?.[0] ?? "";
  const unversioned = path.slice(version.length);
  const prefix = BEARER_PATH_PREFIXES.find((candidate) =>
    unversioned.startsWith(candidate),
  );
  if (prefix === undefined) return path;
  const rest = unversioned.slice(prefix.length);
  if (rest === "") return path;
  const separator = rest.indexOf("/");
  const tail = separator === -1 ? "" : rest.slice(separator);
  return `${version}${prefix.slice(0, -1)}/[redacted]${tail}`;
}

function describeRequest(host: ArgumentsHost): Record<string, unknown> {
  try {
    const req = host.switchToHttp().getRequest<Request>();
    const [rawPath = "", queryString] = req.url.split("?", 2);
    const path = redactBearerPathSegment(rawPath);
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

    const constraint = constraintFailure(exception);
    if (constraint) {
      const { status, ...envelope } = constraint;
      // Logged, not reported: the caller can fix it, but a constraint reaching
      // the filter still means a service skipped a check it should have made.
      logger.warn("Database rejected a write on a constraint", {
        code: envelope.code,
        ...describeUnhandled(exception),
        request: describeRequest(host),
      });
      writeEnvelope(res, status, { ...envelope, ...cid });
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
