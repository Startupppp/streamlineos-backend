import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";
import { finalize } from "rxjs/operators";
import { AdmissionService } from "./admission.service";

type AdmittedRequest = {
  _admissionOrgId?: string;
};

@Injectable()
export class AdmissionInterceptor implements NestInterceptor {
  constructor(private readonly admissionService: AdmissionService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const req = context.switchToHttp().getRequest<AdmittedRequest | undefined>();
    const orgId = req?._admissionOrgId;
    if (orgId === undefined) return next.handle();
    return next.handle().pipe(finalize(() => this.admissionService.release(orgId)));
  }
}
