import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../common/outbox/outbox-consumer.registry";
import { EmailOutboxService } from "../email/email-outbox.service";
import { ReportSchedulesService, REPORT_SCHEDULE_DUE } from "./report-schedules.service";
import { ReportingService } from "./reporting.service";
import { renderReportEmail } from "./report-delivery-render";

/**
 * Runs a due scheduled report and hands the result to the durable email queue.
 *
 * The registration is not bookkeeping: `OutboxPublisherService` throws on an
 * event type it has no consumer for and sends that throw down the retry and
 * dead-letter path. Emitting `crm.report.schedule_due` without this class would
 * not mean "schedules advance and nothing delivers" — it would mean every
 * scheduled report dead-letters, which looks like the feature working right up
 * until somebody asks where the mail is.
 *
 * ## Whose authority the run carries
 *
 * `run_as_user_id`, always. Running a report needs `crm:reporting:run` and the
 * key that governs the source's rows elsewhere, and the compiled statement is
 * narrowed by that person's DataScope. Passing anything else — a service
 * account, or nothing — would make a schedule a way to read rows the person who
 * created it could not, and would keep delivering a leaver's report after their
 * access was withdrawn. `runDefinition` refuses when the authority is gone,
 * which is exactly the behaviour wanted; the refusal is recorded on the row so
 * a schedule that has quietly stopped is visible rather than silent.
 */
@Injectable()
export class ReportScheduleConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = REPORT_SCHEDULE_DUE;
  private readonly logger = new Logger(ReportScheduleConsumer.name);

  constructor(
    private readonly schedules: ReportSchedulesService,
    private readonly reporting: ReportingService,
    private readonly email: EmailOutboxService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const payload = event.payload as { report_schedule_id?: unknown };
    const reportScheduleId = String(payload?.report_schedule_id ?? "");
    if (!reportScheduleId)
      throw new Error(`${REPORT_SCHEDULE_DUE} payload has no report_schedule_id`);

    const orgId = event.organizationId;

    try {
      const schedule = await this.schedules.get(orgId, reportScheduleId);
      const definition = await this.reporting.getDefinition(
        orgId,
        schedule.reportDefinitionId,
      );
      const result = await this.reporting.runDefinition(
        orgId,
        schedule.runAsUserId,
        schedule.reportDefinitionId,
        {},
      );

      const rendered = renderReportEmail({
        reportName: definition.name,
        headers: result.columns.map((column) => columnLabel(column)),
        result,
        ranAt: new Date(),
      });

      /**
       * One message per recipient, not one message with everybody in `to`.
       * A report's distribution list is not something each recipient is
       * entitled to read, and a single message would publish it to all of them.
       */
      for (const recipient of schedule.recipients) {
        await this.email.enqueueAndTry({
          to: recipient,
          organizationId: orgId,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });
      }

      this.logger.debug(
        `report schedule ${reportScheduleId}: ${result.rowCount} rows to ${schedule.recipients.length} recipient(s)`,
      );
    } catch (error) {
      /**
       * Recorded, then rethrown. The record is what makes a dead schedule
       * visible on its own row; the rethrow is what puts the event back on the
       * outbox's retry path and eventually into the dead-letter queue, in
       * public, rather than swallowing a failure nobody would find.
       */
      const message = error instanceof Error ? error.message : String(error);
      await this.schedules.recordFailure(orgId, reportScheduleId, message);
      throw error;
    }
  }
}

/**
 * A column heading a person can read.
 *
 * The compiled column carries the projection it came from, so the heading is
 * derived from what was asked rather than from the generated `c0` alias the
 * rows are keyed on.
 */
function columnLabel(column: {
  projection: { kind: string; field?: string; aggregate?: string };
}): string {
  if (column.projection.kind === "field") return column.projection.field ?? "";
  const aggregate = column.projection.aggregate ?? "";
  return column.projection.field ? `${aggregate}(${column.projection.field})` : aggregate;
}
