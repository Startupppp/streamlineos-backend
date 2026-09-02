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
import { attachAdmissionSlot, type AdmissionScopedRequest } from "./admission-slot";
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
import { reservedClassForPath } from "./reserved-routes";
import type { WorkClass } from "./work-class";
import { WORK_CLASS_KEY } from "./work-class.decorator";

type AdmissionRequest = AdmissionScopedRequest & {
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
    attachAdmissionSlot(req, res, () => this.admissionService.release(bucket));
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
