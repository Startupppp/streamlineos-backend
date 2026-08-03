import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { logger } from "../logger/logger.service";
import { DEPRECATION_KEY, type DeprecationMeta } from "./deprecated.decorator";

@Injectable()
export class DeprecationInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<DeprecationMeta | undefined>(
      DEPRECATION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!meta) return next.handle();

    const req = context.switchToHttp().getRequest<{ url?: string; method?: string }>();
    const route = `${req.method ?? "?"} ${req.url ?? "?"}`;

    return next.handle().pipe(
      tap(() => {
        const res = context.switchToHttp().getResponse<{
          setHeader: (name: string, value: string) => void;
        }>();
        res.setHeader("Deprecation", "true");
        if (meta.sunset) {
          res.setHeader("Sunset", meta.sunset);
        }
        if (meta.link) {
          res.setHeader("Link", `${meta.link}; rel="deprecation"`);
        }
        logger.warn("legacy_endpoint_call", { metric: "legacy_endpoint_call", route });
      }),
    );
  }
}
