import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";
import { finalize } from "rxjs/operators";
import { AdmissionService } from "./admission.service";

type AdmittedRequest = {
  _admissionOrgId?: string;
  _admissionRelease?: () => void;
};

@Injectable()
export class AdmissionInterceptor implements NestInterceptor {
  constructor(private readonly admissionService: AdmissionService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const req = context.switchToHttp().getRequest<AdmittedRequest | undefined>();
    if (req?._admissionRelease === undefined) return next.handle();
    // Through the guard's own release, which is idempotent: the response may also
    // have ended by another route, and a slot must be given back exactly once.
    return next.handle().pipe(finalize(() => req._admissionRelease?.()));
  }
}
