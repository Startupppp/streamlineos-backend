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
import { reservedClassForPath } from "./reserved-routes";
import type { WorkClass } from "./work-class";
import { WORK_CLASS_KEY } from "./work-class.decorator";

type AdmissionRequest = {
  user?: CurrentUserContext;
  path?: string;
  url?: string;
  _admissionOrgId?: string;
  _admissionRelease?: () => void;
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

    const res = http.getResponse<Response>();

    if (!decision.admitted) {
      res.set("Retry-After", String(decision.retryAfterSeconds));
      throw new ServiceUnavailableException({
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily overloaded. Please try again shortly.",
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }

    req._admissionOrgId = orgId;

    /*
      Released when the response ends, however it ends.

      The interceptor's `finalize` only runs if the request reaches the handler
      pipeline, and three guards run after this one — a request refused by
      `ModuleGuard` with a 402, or by `MfaGuard`, was admitted here and never
      released. Each one leaked a slot permanently, so a deployment answering a
      steady trickle of 402s sheds more and more real traffic until it sheds all
      of it. The e-sign RBAC suite fires a hundred of them in a row and starts
      getting 503s halfway through, which is the same thing on a shorter fuse.

      Release is idempotent and the interceptor now goes through it too, so the
      normal path still releases exactly once, as early as it did before.
    */
    const release = () => {
      if (req._admissionRelease === undefined) return;
      req._admissionRelease = undefined;
      this.admissionService.release(orgId);
    };
    req._admissionRelease = release;
    res.on("finish", release);
    res.on("close", release);

    return true;
  }
}
