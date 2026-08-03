import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../logger/logger.service";
import { isTransientDbError } from "../db/transient-error";

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
      const detail = exception.issues
        .map((i) => `${i.path.length ? i.path.join(".") : "body"}: ${i.message}`)
        .join("; ");
      res.status(HttpStatus.BAD_REQUEST).json({ error: `Validation failed: ${detail}` });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        res.status(status).json({ error: body });
        return;
      }
      const obj = body as Record<string, unknown>;
      if (typeof obj.code === "string") {
        const messageField =
          typeof obj.message === "string"
            ? { message: obj.message }
            : typeof obj.error === "string"
              ? { error: obj.error }
              : { message: "Error" };
        res.status(status).json({
          code: obj.code,
          ...messageField,
          ...(obj.details !== undefined ? { details: obj.details } : {}),
        });
        return;
      }
      if (typeof obj.message === "string") {
        res.status(status).json({ error: obj.message });
        return;
      }
      if (Array.isArray(obj.message)) {
        res.status(status).json({ error: (obj.message as string[]).join("; ") });
        return;
      }
      if (typeof obj.error === "string") {
        res.status(status).json(obj);
        return;
      }
      res.status(status).json({ error: "Error" });
      return;
    }

    if (isTransientDbError(exception)) {
      logger.warn("Transient database connection error — returning 503", {
        error: exception instanceof Error ? exception.message : String(exception),
      });
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: "The service is temporarily unavailable. Please try again.",
      });
      return;
    }

    logger.error("Unhandled exception", {
      error: exception,
      ...describeUnhandled(exception),
      request: describeRequest(host),
    });
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "An unexpected error occurred" });
  }
}
