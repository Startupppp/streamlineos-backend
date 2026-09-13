import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  crmReportScheduleRecipients,
  crmReportSchedules,
  organizations,
} from "../../db/schema";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { forEachOrg } from "../../common/tenant";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { ReportingDefinitionsService } from "./reporting-definitions.service";
import { nextRunAt, type CadenceSpec, type ReportCadence } from "./report-schedule-cadence";
import type { CreateScheduleInput, UpdateScheduleInput } from "./dto/reporting.schemas";

/** Matching the column defaults, for the half of a cadence that is not read. */
const DEFAULT_DAY_OF_WEEK = 1;
const DEFAULT_DAY_OF_MONTH = 1;

/** The outbox event a due schedule emits. Consumed by `ReportScheduleConsumer`. */
export const REPORT_SCHEDULE_DUE = "crm.report.schedule_due";

/**
 * How many due schedules one organisation is advanced per tick.
 *
 * Every one of them becomes a report run and an email, so this is a bill as
 * much as a page size. Oldest-due first, so a truncated pass leaves behind the
 * schedules that have been waiting the least time.
 */
const PER_ORG_DUE_LIMIT = 25;

/**
 * Saved reports that arrive without anybody asking.
 *
 * The delivery is deliberately not done here. A sweep that ran the report and
 * sent the mail in one pass would lose both if the process died between them,
 * and would hold a database connection for the length of an email provider's
 * outage. Instead the sweep does one thing atomically — advance `next_run_at`
 * and write the outbox event in the same transaction — and everything after
 * that is the consumer's. That ordering is what makes "this report went out
 * twice" unrepresentable: the row is no longer due the moment the event exists,
 * and the event cannot exist unless the row moved.
 */
@Injectable()
export class ReportSchedulesService {
  private readonly logger = new Logger(ReportSchedulesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly reporting: ReportingDefinitionsService,
  ) {}

  async list(orgId: string) {
    const rows = await this.db
      .select()
      .from(crmReportSchedules)
      .where(eq(crmReportSchedules.organizationId, orgId))
      .orderBy(asc(crmReportSchedules.nextRunAt));

    return Promise.all(rows.map(async (row) => ({ ...row, recipients: await this.recipientsOf(orgId, row.reportScheduleId) })));
  }

  async get(orgId: string, reportScheduleId: string) {
    const [row] = await this.db
      .select()
      .from(crmReportSchedules)
      .where(
        and(
          eq(crmReportSchedules.organizationId, orgId),
          eq(crmReportSchedules.reportScheduleId, reportScheduleId),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("report schedule not found");
    return { ...row, recipients: await this.recipientsOf(orgId, reportScheduleId) };
  }

  /**
   * Creating a schedule proves the report runs, and records whose authority it
   * runs under.
   *
   * `getDefinition` first, so a schedule cannot be attached to a report that
   * does not exist or belongs to another tenant. The creator becomes
   * `run_as_user_id`: a schedule has no requester when it fires, and unattended
   * work with no subject would be a way to read rows the person who set it up
   * could not.
   */
  async create(orgId: string, userId: string, input: CreateScheduleInput) {
    const definition = await this.reporting.getDefinition(orgId, input.reportDefinitionId);
    /**
     * The unread half of a cadence still needs a value, and the column defaults
     * are the honest one: a daily schedule has no weekday, and storing whatever
     * the caller happened to send would make it look chosen.
     */
    const spec = toSpec(
      input.cadence,
      input.hourOfDay,
      input.dayOfWeek ?? DEFAULT_DAY_OF_WEEK,
      input.dayOfMonth ?? DEFAULT_DAY_OF_MONTH,
    );
    const zone = await this.timezoneOf(orgId);

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(crmReportSchedules)
        .values({
          organizationId: orgId,
          reportDefinitionId: definition.reportDefinitionId,
          cadence: spec.cadence,
          hourOfDay: spec.hour,
          dayOfWeek: spec.dayOfWeek,
          dayOfMonth: spec.dayOfMonth,
          runAsUserId: userId,
          createdByUserId: userId,
          nextRunAt: nextRunAt(spec, new Date(), zone),
        })
        .returning();

      if (!row) throw new BadRequestException("report schedule could not be created");

      await tx.insert(crmReportScheduleRecipients).values(
        input.recipients.map((email) => ({
          organizationId: orgId,
          reportScheduleId: row.reportScheduleId,
          email,
        })),
      );

      return { ...row, recipients: [...input.recipients] };
    });
  }

  async update(orgId: string, reportScheduleId: string, input: UpdateScheduleInput) {
    const existing = await this.get(orgId, reportScheduleId);
    const spec = toSpec(
      input.cadence ?? (existing.cadence as ReportCadence),
      input.hourOfDay ?? existing.hourOfDay,
      input.dayOfWeek ?? existing.dayOfWeek,
      input.dayOfMonth ?? existing.dayOfMonth,
    );
    /**
     * The cadence changed, so the pending due time is stale. Recomputed from
     * now rather than adjusted, because "next Tuesday at 9" derived from a daily
     * schedule's pending instant is a different date every time.
     */
    const cadenceChanged =
      input.cadence !== undefined ||
      input.hourOfDay !== undefined ||
      input.dayOfWeek !== undefined ||
      input.dayOfMonth !== undefined;
    const zone = cadenceChanged ? await this.timezoneOf(orgId) : null;

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(crmReportSchedules)
        .set({
          cadence: spec.cadence,
          hourOfDay: spec.hour,
          dayOfWeek: spec.dayOfWeek,
          dayOfMonth: spec.dayOfMonth,
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(zone === null ? {} : { nextRunAt: nextRunAt(spec, new Date(), zone) }),
        })
        .where(
          and(
            eq(crmReportSchedules.organizationId, orgId),
            eq(crmReportSchedules.reportScheduleId, reportScheduleId),
          ),
        )
        .returning();

      if (!row) throw new NotFoundException("report schedule not found");

      if (input.recipients) {
        /**
         * Replaced rather than merged. The list on screen is what the operator
         * means to be true, and a merge would make removing somebody impossible
         * through the only control that exists.
         */
        await tx
          .delete(crmReportScheduleRecipients)
          .where(
            and(
              eq(crmReportScheduleRecipients.organizationId, orgId),
              eq(crmReportScheduleRecipients.reportScheduleId, reportScheduleId),
            ),
          );
        await tx.insert(crmReportScheduleRecipients).values(
          input.recipients.map((email) => ({
            organizationId: orgId,
            reportScheduleId,
            email,
          })),
        );
      }

      return {
        ...row,
        recipients: input.recipients ? [...input.recipients] : existing.recipients,
      };
    });
  }

  async remove(orgId: string, reportScheduleId: string) {
    /** The recipients go with it through the composite FK's ON DELETE CASCADE. */
    const deleted = await this.db
      .delete(crmReportSchedules)
      .where(
        and(
          eq(crmReportSchedules.organizationId, orgId),
          eq(crmReportSchedules.reportScheduleId, reportScheduleId),
        ),
      )
      .returning({ reportScheduleId: crmReportSchedules.reportScheduleId });

    if (deleted.length === 0) throw new NotFoundException("report schedule not found");
    return { deleted: true };
  }

  /**
   * Every organisation's due schedules, claimed and handed to the outbox.
   *
   * Claiming and emitting are one transaction on purpose. If the emit committed
   * without the advance, the schedule would still be due on the next tick and
   * the same report would go out repeatedly; if the advance committed without
   * the emit, the report would silently skip a period. Neither is representable
   * when they share a transaction.
   */
  async sweepDueSchedules(): Promise<{
    organizations: number;
    failed: number;
    claimed: number;
  }> {
    let claimed = 0;
    const now = new Date();

    const result = await forEachOrg(this.db, "crm-report-schedules", async (tx, orgId) => {
      const due = await tx
        .select({
          reportScheduleId: crmReportSchedules.reportScheduleId,
          cadence: crmReportSchedules.cadence,
          hourOfDay: crmReportSchedules.hourOfDay,
          dayOfWeek: crmReportSchedules.dayOfWeek,
          dayOfMonth: crmReportSchedules.dayOfMonth,
        })
        .from(crmReportSchedules)
        .where(
          and(
            eq(crmReportSchedules.organizationId, orgId),
            eq(crmReportSchedules.enabled, true),
            lte(crmReportSchedules.nextRunAt, now),
          ),
        )
        .orderBy(asc(crmReportSchedules.nextRunAt))
        .limit(PER_ORG_DUE_LIMIT);

      if (due.length === 0) return;
      const zone = await this.timezoneOf(orgId);

      for (const schedule of due) {
        const spec = toSpec(
          schedule.cadence as ReportCadence,
          schedule.hourOfDay,
          schedule.dayOfWeek,
          schedule.dayOfMonth,
        );

        /**
         * The run counter is incremented here and read back, because it is the
         * event's aggregate version. `outbox_events` is unique on (org,
         * aggregate type, aggregate id, aggregate version), so emitting version
         * 1 every time would succeed on the first firing and fail on every one
         * after it — a report that arrives once and then silently never again,
         * behind a sweep that logs and moves on.
         */
        const [advanced] = await tx
          .update(crmReportSchedules)
          .set({
            nextRunAt: nextRunAt(spec, now, zone),
            lastRunAt: now,
            lastError: null,
            runCount: sql`${crmReportSchedules.runCount} + 1`,
          })
          .where(
            and(
              eq(crmReportSchedules.organizationId, orgId),
              eq(crmReportSchedules.reportScheduleId, schedule.reportScheduleId),
            ),
          )
          .returning({ runCount: crmReportSchedules.runCount });

        if (!advanced) continue;

        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "crm_report_schedule",
          aggregateId: schedule.reportScheduleId,
          aggregateVersion: advanced.runCount,
          eventType: REPORT_SCHEDULE_DUE,
          payload: {
            organization_id: orgId,
            report_schedule_id: schedule.reportScheduleId,
          },
          occurredAt: now,
        });

        claimed += 1;
      }
    });

    return { organizations: result.succeeded, failed: result.failed, claimed };
  }

  /**
   * Why a scheduled run failed, kept on the row.
   *
   * Written in its own transaction because the consumer's has already gone by
   * the time it fails, and a schedule that silently stops delivering is the
   * worst outcome available here — the operator finds out when somebody asks
   * where last month's numbers are.
   */
  async recordFailure(orgId: string, reportScheduleId: string, message: string): Promise<void> {
    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      await tx
        .update(crmReportSchedules)
        .set({ lastError: message.slice(0, 500) })
        .where(
          and(
            eq(crmReportSchedules.organizationId, orgId),
            eq(crmReportSchedules.reportScheduleId, reportScheduleId),
          ),
        );
    }).catch((error: unknown) => {
      this.logger.error(`could not record schedule failure for ${reportScheduleId}`, error);
    });
  }

  private async recipientsOf(orgId: string, reportScheduleId: string): Promise<string[]> {
    const rows = await this.db
      .select({ email: crmReportScheduleRecipients.email })
      .from(crmReportScheduleRecipients)
      .where(
        and(
          eq(crmReportScheduleRecipients.organizationId, orgId),
          eq(crmReportScheduleRecipients.reportScheduleId, reportScheduleId),
        ),
      )
      .orderBy(asc(crmReportScheduleRecipients.email));

    return rows.map((row) => row.email);
  }

  /**
   * The organisation's zone, read at sweep time rather than copied onto the
   * schedule — so moving the organisation moves its reports, which is what an
   * operator who changed it would expect.
   */
  private async timezoneOf(orgId: string): Promise<string> {
    const [row] = await this.db
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    return row?.timezone ?? "UTC";
  }
}

function toSpec(
  cadence: ReportCadence,
  hour: number,
  dayOfWeek: number,
  dayOfMonth: number,
): CadenceSpec {
  return { cadence, hour, dayOfWeek, dayOfMonth };
}
