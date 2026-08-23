import {
  Inject,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { from, lastValueFrom, type Observable } from "rxjs";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { NO_TENANT_TRANSACTION } from "./no-tenant-transaction.decorator";
import {
  TenantContextService,
  type AfterCommitHook,
  type TenantAudience,
} from "./tenant-context";
import { withTenant } from "./with-tenant";
import { bindObservabilityContext, reportError } from "../observability";

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
  private readonly logger = new Logger(TenantContextInterceptor.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly tenant: TenantContextService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const optedOut = this.reflector.getAllAndOverride<boolean | undefined>(
      NO_TENANT_TRANSACTION,
      [context.getHandler(), context.getClass()],
    );
    if (optedOut) return next.handle();

    const req = context.switchToHttp().getRequest<TenantBearingRequest>();
    const resolved = resolveTenant(req);
    if (!resolved) return next.handle();

    return from(this.runInTenantTransaction(resolved, next));
  }

  private async runInTenantTransaction(
    resolved: { orgId: string; audience: TenantAudience },
    next: CallHandler,
  ): Promise<unknown> {
    const afterCommit: AfterCommitHook[] = [];

    const result = await withTenant(this.db, resolved, (tx) =>
      this.tenant.run({ ...resolved, tx, afterCommit }, () =>
        lastValueFrom(next.handle()),
      ),
    );

    for (const hook of afterCommit) {
      // Bound explicitly: the hook is detached from the request, and inheriting the
      // caller's identity by accident is not something to rely on.
      const run = bindObservabilityContext(hook);
      void run().catch((error: unknown) => {
        this.logger.error(
          `after-commit hook failed for org ${resolved.orgId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        // A deferred failure that is only logged is the next outage nobody saw coming.
        reportError(error, { orgId: resolved.orgId, phase: "after-commit" });
      });
    }

    return result;
  }
}
