import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";
import { finalize } from "rxjs/operators";
import type { AdmissionScopedRequest } from "./admission-slot";
import { AdmissionService } from "./admission.service";

@Injectable()
export class AdmissionInterceptor implements NestInterceptor {
  constructor(private readonly admissionService: AdmissionService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const req = context.switchToHttp().getRequest<AdmissionScopedRequest | undefined>();
    if (req === undefined) return next.handle();

    const orgId = req._admissionOrgId;
    if (orgId === undefined) return next.handle();

    const release = req._admissionRelease ?? (() => this.admissionService.release(orgId));
    return next.handle().pipe(finalize(release));
  }
}
