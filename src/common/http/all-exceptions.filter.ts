import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { logger } from "../logger/logger.service";

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
        res.status(status).json({
          code: obj.code,
          message: typeof obj.message === "string" ? obj.message : "Error",
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

    logger.error("Unhandled exception", { error: exception });
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "An unexpected error occurred" });
  }
}
