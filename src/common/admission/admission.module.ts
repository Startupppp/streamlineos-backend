import { Global, Module } from "@nestjs/common";
import { resolveAdmissionConfig } from "./admission.config";
import { AdmissionGuard } from "./admission.guard";
import { AdmissionInterceptor } from "./admission.interceptor";
import { AdmissionService } from "./admission.service";

@Global()
@Module({
  providers: [
    {
      provide: AdmissionService,
      useFactory: () => new AdmissionService(resolveAdmissionConfig()),
    },
    AdmissionGuard,
    AdmissionInterceptor,
  ],
  exports: [AdmissionService, AdmissionGuard, AdmissionInterceptor],
})
export class AdmissionModule {}
