import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { Observable } from "rxjs";
import { VALIDATION_SCHEMAS, type ValidationSchemas } from "./validate.decorator";


@Injectable()
export class ZodValidationInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const schemas = this.reflector.getAllAndOverride<ValidationSchemas | undefined>(
      VALIDATION_SCHEMAS,
      [context.getHandler(), context.getClass()],
    );
    if (!schemas) return next.handle();

    const req = context.switchToHttp().getRequest<Request>();

    if (schemas.body) {
      req.body = schemas.body.parse(req.body);
    }
    if (schemas.query) {
      const parsedQuery = schemas.query.parse(req.query);
      /*
        Redefined, not assigned into. Express 5 exposes `query` as a getter that
        re-parses the URL on every access, so `Object.assign(req.query, parsed)`
        mutates a throwaway object and the handler reads the raw strings back.
        Validation still rejected bad input, which is why this looked like it
        worked — but no coercion, default or transform ever reached a handler:
        `limit` stayed a string, so `limit + 1` concatenated, and an omitted one
        stayed undefined, so the read ran unbounded; `?includeCompleted=false`
        stayed the string "false", which is truthy, so a filter a caller
        explicitly turned off stayed on.
      */
      Object.defineProperty(req, "query", {
        value: parsedQuery,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    if (schemas.params) {
      const parsedParams = schemas.params.parse(req.params);
      Object.assign(req.params, parsedParams);
    }

    return next.handle();
  }
}
