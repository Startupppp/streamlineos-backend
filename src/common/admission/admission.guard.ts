import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Response } from "express";
import type { CurrentUserContext } from "../auth/backend-claims";
import { attachAdmissionSlot, type AdmissionScopedRequest } from "./admission-slot";
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
  constructor(
    private readonly reflector: Reflector,
    private readonly admissionService: AdmissionService,
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

    const orgId = req.user?.orgId ?? "__public__";
    const decision = this.admissionService.tryAdmit(workClass, orgId);

    if (!decision.admitted) {
      res.set("Retry-After", String(decision.retryAfterSeconds));
      throw new ServiceUnavailableException({
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily overloaded. Please try again shortly.",
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }

    req._admissionOrgId = orgId;
    attachAdmissionSlot(req, res, () => this.admissionService.release(orgId));
    return true;
  }
}
