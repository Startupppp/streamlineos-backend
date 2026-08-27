import { Module } from "@nestjs/common";
import { ReportingController } from "./reporting.controller";
import { ReportingService } from "./reporting.service";

/**
 * The query description compiler, and the surface that reaches it.
 *
 * It imports nothing. `AccessModule` is `@Global`, so `AccessService` — the only
 * collaborator the service has — is injectable without an import, and the
 * compiler beneath it is pure functions over a static registry with no
 * dependencies at all. That is not an accident of size: the compiler is the
 * dangerous part of this module, and keeping it free of injection is what lets
 * its specs exercise the real production code path rather than a wiring of it.
 *
 * `ReportingService` is exported so a workflow step or a scheduled digest can
 * run a saved report later without acquiring the controller or reimplementing
 * the permission decision. Nothing consumes it yet — that is stated plainly
 * rather than implied, because an export nobody imports is not a feature.
 */
@Module({
  controllers: [ReportingController],
  providers: [ReportingService],
  exports: [ReportingService],
})
export class ReportingModule {}
