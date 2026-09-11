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
import {
  TenantContextService,
  type AfterCommitHook,
  type TenantAudience,
} from "./tenant-context";
import { withTenant } from "./with-tenant";
import type { PlacementIntent } from "../region/placement";
import { drainAfterCommitHooks } from "./run-in-tenant-transaction";
import {
  createStreamAbortSignal,
  type CloseableRequest as StreamAbortRequest,
  type EndableResponse,
} from "../http/stream-abort";
import { resolveAdmissionConfig } from "../admission/admission.config";

interface TenantBearingRequest {
  method?: string;
  user?: { orgId?: string };
  portalUser?: { organizationId?: string };
  apiKey?: { orgId?: string };
}

interface CloseableRequest extends TenantBearingRequest, StreamAbortRequest {}

type WritableResponse = EndableResponse;

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const REQUEST_DEADLINE_MS = resolveAdmissionConfig().maxExecutionMs;

interface ResolvedTenant {
  orgId: string;
  audience: TenantAudience;
  intent: PlacementIntent;
}

function resolveTenant(req: TenantBearingRequest): ResolvedTenant | null {
  const intent: PlacementIntent = READ_ONLY_METHODS.has(
    (req.method ?? "").toUpperCase(),
  )
    ? "read"
    : "write";

  const portalOrgId = req.portalUser?.organizationId;
  if (portalOrgId) return { orgId: portalOrgId, audience: "PORTAL", intent };

  const orgId = req.user?.orgId;
  if (orgId) return { orgId, audience: "INTERNAL", intent };

  // ApiKeyGuard is the third way a request names a tenant. It sets `req.apiKey`, not `req.user`,
  // so every API-key route ran with no GUC at all and 42501'd on the first RLS table it touched.
  const apiKeyOrgId = req.apiKey?.orgId;
  if (apiKeyOrgId) return { orgId: apiKeyOrgId, audience: "INTERNAL", intent };

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

    const optedOut = this.reflector.getAllAndOverride<boolean | undefined>(
      NO_TENANT_TRANSACTION,
      [context.getHandler(), context.getClass()],
    );
    if (optedOut) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<CloseableRequest>();
    const res = http.getResponse<WritableResponse>();
    const resolved = resolveTenant(req);
    if (!resolved) return next.handle();

    const abort = createStreamAbortSignal(req, res, REQUEST_DEADLINE_MS);

    return from(
      this.runInTenantTransaction(resolved, next, abort.signal).finally(() => {
        abort.dispose();
      }),
    );
  }

  private async runInTenantTransaction(
    resolved: ResolvedTenant,
    next: CallHandler,
    abortSignal: AbortSignal,
  ): Promise<unknown> {
    const afterCommit: AfterCommitHook[] = [];
    const tenant = { orgId: resolved.orgId, audience: resolved.audience };

    const result = await withTenant(this.db, resolved, (tx) =>
      this.tenant.run({ ...tenant, tx, afterCommit, abortSignal }, () =>
        lastValueFrom(next.handle()),
      ),
    );

    drainAfterCommitHooks(this.db, resolved.orgId, afterCommit);

    return result;
  }
}
