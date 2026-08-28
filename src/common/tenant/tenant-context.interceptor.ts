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
import type { PlacementIntent } from "../region/placement";
import { bindObservabilityContext, reportError } from "../observability";
import { runInNewTenantTransaction } from "./run-in-tenant-transaction";

interface TenantBearingRequest {
  method?: string;
  user?: { orgId?: string };
  portalUser?: { organizationId?: string };
}

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface ResolvedTenant {
  orgId: string;
  audience: TenantAudience;
  intent: PlacementIntent;
}

function resolveTenant(req: TenantBearingRequest): ResolvedTenant | null {
  // A request that cannot write is not fenced; anything else is, including an
  // unrecognised method, because guessing "read" would skip the fence.
  const intent: PlacementIntent = READ_ONLY_METHODS.has(
    (req.method ?? "").toUpperCase(),
  )
    ? "read"
    : "write";

  const portalOrgId = req.portalUser?.organizationId;
  if (portalOrgId)
    return { orgId: portalOrgId, audience: "PORTAL", intent };

  const orgId = req.user?.orgId;
  // A signed-in user with no workspace yet has orgId "" — nothing tenant-scoped to open
  if (orgId) return { orgId, audience: "INTERNAL", intent };

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
    resolved: ResolvedTenant,
    next: CallHandler,
  ): Promise<unknown> {
    const afterCommit: AfterCommitHook[] = [];
    const tenant = { orgId: resolved.orgId, audience: resolved.audience };

    const result = await withTenant(this.db, resolved, (tx) =>
      this.tenant.run({ ...tenant, tx, afterCommit }, () =>
        lastValueFrom(next.handle()),
      ),
    );

    for (const hook of afterCommit) {
      const run = bindObservabilityContext(async () => {
        await runInNewTenantTransaction(this.db, resolved.orgId, async () => {
          await hook();
        });
      });
      void run().catch((error: unknown) => {
        this.logger.error(
          `after-commit hook failed for org ${resolved.orgId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        reportError(error, { orgId: resolved.orgId, phase: "after-commit" });
      });
    }

    return result;
  }
}
