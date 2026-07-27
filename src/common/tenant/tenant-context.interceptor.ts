import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import type { Request } from "express";
import { Observable, type Subscription } from "rxjs";
import type { CurrentUserContext } from "../auth/backend-claims";
import type { PortalUserContext } from "../portal-auth/portal-claims";
import type { TenantContext } from "../../db/rls-context";
import { TenantContextService } from "./tenant-context";

type AuthenticatedRequest = Request & {
  user?: CurrentUserContext;
  portalUser?: PortalUserContext;
};

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const tenantCtx = this.resolveContext(req);

    if (!tenantCtx) {
      return next.handle();
    }

    return new Observable<unknown>((subscriber) => {
      let sub: Subscription | undefined;

      const promise = this.tenantContext.run(tenantCtx, () =>
        new Promise<void>((resolve, reject) => {
          sub = next.handle().subscribe({
            next: (v) => subscriber.next(v),
            error: (e: unknown) => {
              subscriber.error(e);
              reject(e);
            },
            complete: () => {
              subscriber.complete();
              resolve();
            },
          });
        }),
      );

      promise.catch((e: unknown) => subscriber.error(e));

      return () => sub?.unsubscribe();
    });
  }

  private resolveContext(req: AuthenticatedRequest): TenantContext | undefined {
    if (req.user?.orgId) {
      return {
        orgId: req.user.orgId,
        audience: "INTERNAL",
        membershipId: undefined,
      };
    }
    if (req.portalUser?.organizationId) {
      return {
        orgId: req.portalUser.organizationId,
        audience: "PORTAL",
        membershipId: req.portalUser.portalMembershipId,
      };
    }
    return undefined;
  }
}
