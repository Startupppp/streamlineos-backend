import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { from, lastValueFrom, type Observable } from "rxjs";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { NO_TENANT_TRANSACTION } from "./no-tenant-transaction.decorator";
import { TenantContextService, type TenantAudience } from "./tenant-context";
import { withTenant } from "./with-tenant";

interface TenantBearingRequest {
  user?: { orgId?: string };
  portalUser?: { organizationId?: string };
}

function resolveTenant(
  req: TenantBearingRequest,
): { orgId: string; audience: TenantAudience } | null {
  const portalOrgId = req.portalUser?.organizationId;
  if (portalOrgId) return { orgId: portalOrgId, audience: "PORTAL" };

  const orgId = req.user?.orgId;
  // A signed-in user with no workspace yet has orgId "" — nothing tenant-scoped to open
  if (orgId) return { orgId, audience: "INTERNAL" };

  return null;
}

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly tenant: TenantContextService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const optedOut = this.reflector.getAllAndOverride<boolean | undefined>(NO_TENANT_TRANSACTION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (optedOut) return next.handle();

    const req = context.switchToHttp().getRequest<TenantBearingRequest>();
    const resolved = resolveTenant(req);
    if (!resolved) return next.handle();

    return from(
      withTenant(this.db, resolved, (tx) =>
        this.tenant.run({ ...resolved, tx }, () => lastValueFrom(next.handle())),
      ),
    );
  }
}
