import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";
import { finalize } from "rxjs/operators";
import { AdmissionService } from "./admission.service";
import { releaseAdmissionOnce, type AdmittedRequest } from "./release-once";

@Injectable()
export class AdmissionInterceptor implements NestInterceptor {
  constructor(private readonly admissionService: AdmissionService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const req = context.switchToHttp().getRequest<AdmittedRequest | undefined>();
    if (req?._admissionOrgId === undefined) return next.handle();
    /**
     * Kept, and now idempotent. The guard's response listener covers every
     * outcome including the ones this cannot see, but `finalize` runs the moment
     * the handler settles rather than when the bytes are out, so releasing here
     * returns capacity sooner on the common path. `releaseAdmissionOnce` is what
     * makes having both safe.
     */
    return next.handle().pipe(finalize(() => { releaseAdmissionOnce(req, this.admissionService); }));
  }
}
