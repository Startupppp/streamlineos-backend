import { Module } from "@nestjs/common";
import { EmailModule } from "../email/email.module";
import { OutboxModule } from "../../common/outbox/outbox.module";
import { ReportingController } from "./reporting.controller";
import { ReportingService } from "./reporting.service";
import { ReportSchedulesController } from "./report-schedules.controller";
import { ReportSchedulesService } from "./report-schedules.service";
import { ReportScheduleConsumer } from "./report-schedule.consumer";

/**
 * The query description compiler, the surface that reaches it, and the
 * timetable that runs saved reports without anybody asking.
 *
 * The compiler still imports nothing. `AccessModule` is `@Global`, so
 * `AccessService` — the only collaborator the reporting service has — is
 * injectable without an import, and the compiler beneath it is pure functions
 * over a static registry with no dependencies at all. That is not an accident
 * of size: the compiler is the dangerous part of this module, and keeping it
 * free of injection is what lets its specs exercise the real production code
 * path rather than a wiring of it.
 *
 * Scheduling brings two imports and no more. `OutboxModule` for the consumer
 * registry, because a due schedule is queued rather than run inside the sweep —
 * running the report and sending the mail in one pass would lose both if the
 * process died between them. `EmailModule` for the durable queue that carries
 * the delivery, which already owns suppression and retry; a second sender here
 * would have to reimplement both and would get the first one wrong.
 *
 * `ReportingService` is exported and now has a consumer inside this module as
 * well as outside it.
 */
@Module({
  imports: [OutboxModule, EmailModule],
  controllers: [ReportingController, ReportSchedulesController],
  providers: [ReportingService, ReportSchedulesService, ReportScheduleConsumer],
  exports: [ReportingService, ReportSchedulesService],
})
export class ReportingModule {}
