import { Module } from "@nestjs/common";
import { SubprocessorsController } from "./subprocessors.controller";
import { SubprocessorsService } from "./subprocessors.service";
import { SubjectRequestsController } from "./subject-requests/subject-requests.controller";
import { SubjectRequestsService } from "./subject-requests/subject-requests.service";

/**
 * Operable compliance surfaces: the things a customer's counsel reads before
 * they can buy, and a data subject uses to exercise a right.
 *
 * The register is here rather than in `settings` because it is platform data
 * describing us, not configuration belonging to a tenant. Subject requests sit
 * beside it for the same reason and one more: a data subject may exist in
 * several organisations and has one right across all of them, so the surface
 * cannot belong to any one tenant's module.
 *
 * Imports nothing: `DrizzleModule` is `@Global()`, and the region registry is a
 * module-level singleton rather than an injectable, because `withTenant` is a
 * plain function called from interceptors and cron alike.
 */
@Module({
  controllers: [SubprocessorsController, SubjectRequestsController],
  providers: [SubprocessorsService, SubjectRequestsService],
  exports: [SubprocessorsService, SubjectRequestsService],
})
export class ComplianceModule {}
