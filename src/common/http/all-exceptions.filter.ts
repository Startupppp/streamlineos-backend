import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../logger/logger.service";
import { isTransientDbError } from "../db/transient-error";

type ApiErrorEnvelope = {
  code: string;
  message: string;
  details?: unknown;
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
      (message): message is string => typeof message === "string" && !!message.trim(),
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

function bodyParserFailure(exception: unknown): (ApiErrorEnvelope & { status: number }) | null {
  if (typeof exception !== "object" || exception === null) return null;
  if (!("type" in exception)) return null;
  const type = Reflect.get(exception, "type");
  if (typeof type !== "string") return null;
  const status = BODY_PARSER_STATUS[type];
  if (status === undefined) return null;
  return {
    status,
    code: defaultCode(status),
    message: BODY_PARSER_MESSAGE[status] ?? "The request could not be completed.",
  };
}

function describeUnhandled(exception: unknown): Record<string, unknown> {
  if (!(exception instanceof Error)) return { message: String(exception) };
  const record = exception as unknown as Record<string, unknown>;
  const detail = record["detail"];
  const hint = record["hint"];
  const query = record["query"];
  const column = record["column_name"];
  const table = record["table_name"];
  return {
    message: exception.message,
    stack: exception.stack,
    ...(typeof detail === "string" ? { detail } : {}),
    ...(typeof hint === "string" ? { hint } : {}),
    ...(typeof column === "string" ? { column } : {}),
    ...(typeof table === "string" ? { table } : {}),
    ...(typeof query === "string" ? { query } : {}),
  };
}

function describeRequest(host: ArgumentsHost): Record<string, unknown> {
  try {
    const req = host.switchToHttp().getRequest<Request>();
    return { method: req.method, url: req.url };
  } catch {
    return {};
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ZodError) {
      const details = exception.issues.map((issue) => ({
        path: issue.path.length ? issue.path.join(".") : "body",
        message: issue.message,
      }));
      res.status(HttpStatus.BAD_REQUEST).json({
        code: "VALIDATION_FAILED",
        message: "Validation failed.",
        details,
      } satisfies ApiErrorEnvelope);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res
        .status(status)
        .json(httpErrorEnvelope(status, body as string | Record<string, unknown>));
      return;
    }

    const parserFailure = bodyParserFailure(exception);
    if (parserFailure) {
      const { status, ...envelope } = parserFailure;
      logger.warn("Rejected an unreadable request body", {
        code: envelope.code,
        request: describeRequest(host),
      });
      res.status(status).json(envelope satisfies ApiErrorEnvelope);
      return;
    }

    if (isTransientDbError(exception)) {
      logger.warn("Transient database connection error — returning 503", {
        error: exception instanceof Error ? exception.message : String(exception),
      });
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily unavailable. Please try again.",
      } satisfies ApiErrorEnvelope);
      return;
    }

    logger.error("Unhandled exception", {
      error: exception,
      ...describeUnhandled(exception),
      request: describeRequest(host),
    });
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    } satisfies ApiErrorEnvelope);
  }
}
