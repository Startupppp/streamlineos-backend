import { Module } from "@nestjs/common";
import { CrmSegmentsController } from "./crm-segments.controller";
import { CrmSegmentsService } from "./crm-segments.service";

/**
 * Segments: named criteria over CRM parties, evaluated on read.
 *
 * No imports, and that is the reuse argument in its shortest form. The module
 * that turns criteria into SQL is `modules/reporting/compiler`, which is pure
 * functions over a static registry with no dependencies at all — so consuming it
 * costs nothing in wiring and adds no edge to the module graph. `AccessModule` is
 * `@Global`, so `AccessService` is injectable without an import.
 *
 * The consequence worth naming: if this module ever grows an import of
 * `ReportingModule`, something has gone wrong. It would mean segments had
 * started reaching for saved reports, schedules or the run log — surfaces that
 * answer a different question — and the two features would be on their way to
 * being one.
 */
@Module({
  controllers: [CrmSegmentsController],
  providers: [CrmSegmentsService],
  exports: [CrmSegmentsService],
})
export class CrmSegmentsModule {}
