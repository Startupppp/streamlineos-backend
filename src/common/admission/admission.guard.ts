import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Type } from "@nestjs/common";
import { ModuleRef, Reflector } from "@nestjs/core";
import type { Response } from "express";
import type { CurrentUserContext } from "../auth/backend-claims";
import {
  ADMISSION_TENANT_HINT_KEY,
  hintedBucket,
  isAdmissionHintToken,
  isAdmissionTenantHintProvider,
  PUBLIC_ADMISSION_BUCKET,
  sanitiseTenantHint,
  type AdmissionTenantHintProvider,
} from "./admission-tenant-hint";
import { AdmissionService } from "./admission.service";
import { releaseWhenResponseEnds, type AdmittedRequest } from "./release-once";
import { reservedClassForPath } from "./reserved-routes";
import type { WorkClass } from "./work-class";
import { WORK_CLASS_KEY } from "./work-class.decorator";

type AdmissionRequest = AdmittedRequest & {
  user?: CurrentUserContext;
  path?: string;
  url?: string;
};

@Injectable()
export class AdmissionGuard implements CanActivate {
  private readonly hintProviders = new Map<unknown, AdmissionTenantHintProvider | null>();

  constructor(
    private readonly reflector: Reflector,
    private readonly admissionService: AdmissionService,
    private readonly moduleRef: ModuleRef,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") return true;

    const http = context.switchToHttp();
    const req = http.getRequest<AdmissionRequest>();
    const res = http.getResponse<Response>();

    const declared = this.reflector.getAllAndOverride<WorkClass | undefined>(WORK_CLASS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const workClass =
      declared ?? reservedClassForPath(req.path ?? req.url ?? "") ?? "ordinary-write";

    const bucket = this.bucketFor(context, req);
    const decision = this.admissionService.tryAdmit(workClass, bucket);

    if (!decision.admitted) {
      res.set("Retry-After", String(decision.retryAfterSeconds));
      throw new ServiceUnavailableException({
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily overloaded. Please try again shortly.",
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }

    req._admissionOrgId = bucket;

    /**
     * Registered HERE, not left to `AdmissionInterceptor`.
     *
     * This guard is the third global `APP_GUARD`; `MfaGuard` and `ModuleGuard`
     * run after it, and Nest runs interceptors only once every guard has
     * passed. So a request admitted here and then refused downstream — a 402
     * for an unbought module, a 403 for MFA — never reached the interceptor and
     * never gave its slot back. `orgMaxConcurrent` defaults to 50, so roughly
     * fifty failed requests permanently exhausted an organisation's budget and
     * everything after that 503'd forever: a tenant-wide denial of service any
     * signed-in user could inflict on themselves, or on their colleagues. The
     * e-sign RBAC suite fires a hundred 402s in a row and started getting 503s
     * halfway through, which is the same thing on a shorter fuse.
     *
     * The response ending is the one event common to every outcome there is.
     * Release is idempotent (`releaseAdmissionOnce`) and the interceptor goes
     * through it too, so the normal path still releases exactly once, as early
     * as it did before. It releases `_admissionOrgId`, which is the bucket the
     * slot was charged to — a hinted public route's `hint:` bucket included.
     */
    releaseWhenResponseEnds(req, res, this.admissionService);
    return true;
  }

  // The bucket is a counter key, nothing more. An authenticated request is charged to its verified
  // org; a `@Public()` route that declares a tenant hint is charged to a namespaced bucket derived
  // from server-side state; everything else shares the public bucket. Nothing here authenticates,
  // and the hint never reaches `req.user` or any authorization decision.
  private bucketFor(context: ExecutionContext, req: AdmissionRequest): string {
    const authenticated = req.user?.orgId;
    if (authenticated !== undefined) return authenticated;

    const hinted = this.tenantHint(context, req);
    return hinted === undefined ? PUBLIC_ADMISSION_BUCKET : hintedBucket(hinted);
  }

  private tenantHint(context: ExecutionContext, req: AdmissionRequest): string | undefined {
    const declared = this.reflector.getAllAndOverride<unknown>(ADMISSION_TENANT_HINT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isAdmissionHintToken(declared)) return undefined;

    const provider = this.hintProvider(declared);
    if (provider === null) return undefined;

    try {
      return sanitiseTenantHint(provider.resolveAdmissionTenantOrgId(req));
    } catch {
      return undefined;
    }
  }

  private hintProvider(
    token: Type<AdmissionTenantHintProvider>,
  ): AdmissionTenantHintProvider | null {
    const cached = this.hintProviders.get(token);
    if (cached !== undefined) return cached;

    let resolved: AdmissionTenantHintProvider | null = null;
    try {
      const candidate: unknown = this.moduleRef.get(token, { strict: false });
      if (isAdmissionTenantHintProvider(candidate)) resolved = candidate;
    } catch {
      resolved = null;
    }

    this.hintProviders.set(token, resolved);
    return resolved;
  }
}
