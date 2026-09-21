import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { from, lastValueFrom, type Observable } from "rxjs";
import type { Request } from "express";
import type { CurrentUserContext } from "../auth/backend-claims";
import { runWithImpersonationContext } from "./impersonation-context";

@Injectable()
export class ImpersonationContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserContext }>();

    const impersonation = req.user?.impersonation;
    if (!impersonation) return next.handle();

    return from(
      runWithImpersonationContext(
        {
          realActorUserId: impersonation.realActorUserId,
          impersonationSessionId: impersonation.impersonationSessionId,
        },
        () => lastValueFrom(next.handle()),
      ),
    );
  }
}
