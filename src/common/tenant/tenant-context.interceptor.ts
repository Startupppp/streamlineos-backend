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
}

interface CloseableRequest extends TenantBearingRequest, StreamAbortRequest {}

type WritableResponse = EndableResponse;

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The request deadline, propagated rather than declared and dropped (PRD-C091).
 *
 * `createStreamAbortSignal` has always taken a `deadlineMs`, and this interceptor —
 * the one that arms the signal every tenant-scoped request runs under — passed `null`.
 * So of the two arms that abort a request, only `client_disconnected` was ever
 * reachable outside `src/modules/ai`: `deadline_exceeded` existed in the type, in the
 * timer branch and in the reason union, and nothing could produce it. A request that
 * hung on a slow upstream ran until something else gave up.
 *
 * The value is `admission.maxExecutionMs`, which the admission config already declares
 * as this deployment's per-request execution ceiling and already uses as the weight
 * divisor for queue accounting (`admission.service.ts:80`) — so the deadline the
 * scheduler assumes and the deadline the request enforces are now the same number
 * instead of one assumption and one absence. It defaults to `statementTimeoutMs`
 * (30 s) and is overridable with `ADMISSION_MAX_EXECUTION_MS`.
 *
 * Resolved once at module load, matching `AdmissionModule`'s own factory: the value is
 * environment, not per-request state, and re-parsing it 200 times a second to get the
 * same answer is worse than a snapshot.
 *
 * WHAT THIS DOES NOT DO. Aborting the signal does not itself cancel a running query or
 * an in-flight provider call — only a consumer that reads the signal can do that, and
 * today the only one is the AI gateway's ambient fallback. What it does is make the
 * deadline REACHABLE, so a consumer that adopts it has something to adopt. Cancelling
 * outbound provider calls on it is deliberately NOT done here: `callProvider` is used
 * for side-effecting calls (a payment capture among them), and abandoning one
 * mid-flight on a client disconnect turns a completed external effect into an
 * unrecorded one. That needs a per-descriptor opt-in, and it is named in report 04.
 */
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
  if (portalOrgId)
    return { orgId: portalOrgId, audience: "PORTAL", intent };

  const orgId = req.user?.orgId;
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
