import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { enrichObservabilityContext } from "./observability-context";

interface IdentityBearingRequest {
  user?: { orgId?: string; userId?: string };
  portalUser?: { organizationId?: string; portalUserId?: string };
}

/**
 * Fills in who the caller is, once the guards have worked it out.
 *
 * Separate from the correlation middleware because identity is not known at the
 * edge: middleware runs before authentication, interceptors run after the guards.
 * The ambient context established by the middleware is still the same one, so
 * enrichment lands on the record every later log line will read.
 */
@Injectable()
export class ObservabilityEnrichmentInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const req = context.switchToHttp().getRequest<IdentityBearingRequest>();

    enrichObservabilityContext({
      orgId: req.portalUser?.organizationId ?? req.user?.orgId,
      actorId: req.portalUser?.portalUserId ?? req.user?.userId,
    });

    return next.handle();
  }
}
