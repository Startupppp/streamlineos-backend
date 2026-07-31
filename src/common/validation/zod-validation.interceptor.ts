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
      Object.assign(req.query, parsedQuery);
    }
    if (schemas.params) {
      const parsedParams = schemas.params.parse(req.params);
      Object.assign(req.params, parsedParams);
    }

    return next.handle();
  }
}
