import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Response } from "express";
import type { CurrentUserContext } from "../auth/backend-claims";
import { AdmissionService } from "./admission.service";
import { releaseWhenResponseEnds } from "./release-once";
import { reservedClassForPath } from "./reserved-routes";
import type { WorkClass } from "./work-class";
import { WORK_CLASS_KEY } from "./work-class.decorator";

type AdmissionRequest = {
  user?: CurrentUserContext;
  path?: string;
  url?: string;
  _admissionOrgId?: string;
  _admissionReleased?: boolean;
};

@Injectable()
export class AdmissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly admissionService: AdmissionService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") return true;

    const http = context.switchToHttp();
    const req = http.getRequest<AdmissionRequest>();

    const declared = this.reflector.getAllAndOverride<WorkClass | undefined>(WORK_CLASS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const workClass =
      declared ?? reservedClassForPath(req.path ?? req.url ?? "") ?? "ordinary-write";

    const orgId = req.user?.orgId ?? "__public__";
    const decision = this.admissionService.tryAdmit(workClass, orgId);

    if (!decision.admitted) {
      const res = http.getResponse<Response>();
      res.set("Retry-After", String(decision.retryAfterSeconds));
      throw new ServiceUnavailableException({
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily overloaded. Please try again shortly.",
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }

    req._admissionOrgId = orgId;

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
     * signed-in user could inflict on themselves, or on their colleagues.
     *
     * The response ending is the one event common to every outcome there is.
     */
    releaseWhenResponseEnds(req, http.getResponse<Response>(), this.admissionService);
    return true;
  }
}
