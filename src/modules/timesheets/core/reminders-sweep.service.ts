import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheetPeriods, timesheetSettings } from "../../../db/schema";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { NotificationEventKey } from "../../notifications/notification-events.catalog";
import {
  dueDateFor,
  reminderDue,
  resolveReminderRules,
  type ReminderKind,
} from "./dto/reminder-rules.schemas";

/**
 * Typed against the catalog union rather than `string`, so a key that is not
 * in `NOTIFICATION_EVENT_CATALOG` fails to compile. Widening it to `string`
 * would move that failure to runtime, where `resolveDefinition` returns null
 * and `emit` throws BadRequest — inside a background sweep, per organisation,
 * where nobody would see it.
 */
const EVENT_KEY = {
  DUE_SOON: "timesheets.period.due_soon",
  OVERDUE: "timesheets.period.overdue",
} as const satisfies Record<ReminderKind, NotificationEventKey>;

export interface ReminderSweepResult {
  orgsScanned: number;
  /** Organisations whose stored rules did not parse — see below. */
  orgsMalformed: number;
  periodsConsidered: number;
  remindersSent: number;
}

/**
 * Sends the reminders `timesheet_settings.reminder_rules` has been promising.
 *
 * The column has been writable since it shipped and read by nothing, so an
 * organisation that configured reminders got silence. This is the reader.
 *
 * Two design choices are worth stating because the alternatives look
 * reasonable:
 *
 * **Malformed rules are counted, not thrown on.** Rows written before the
 * column had a schema hold whatever they hold. Throwing would let one bad row
 * stop every other organisation's reminders, so a row that will not parse is
 * treated as "no reminders" — and reported, because an organisation whose
 * configuration is being ignored is not the same as one that configured
 * nothing.
 *
 * **`today` is a parameter.** Not for the tests' convenience; because a sweep
 * that reads the clock in the middle of a loop can straddle midnight and remind
 * some organisations for one day and the rest for the next. Fixing it once at
 * the top makes the whole sweep answer for a single date.
 */
@Injectable()
export class TimesheetRemindersSweepService {
  private readonly logger = new Logger(TimesheetRemindersSweepService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationDispatchService,
  ) {}

  async remindAllOrgs(today = new Date().toISOString().slice(0, 10)): Promise<ReminderSweepResult> {
    const result: ReminderSweepResult = {
      orgsScanned: 0,
      orgsMalformed: 0,
      periodsConsidered: 0,
      remindersSent: 0,
    };

    await forEachOrg(this.db, "timesheets-reminders", async (_tx, orgId) => {
      const org = await this.remindOrg(orgId, today);
      if (!org) return;
      result.orgsScanned++;
      if (org.malformed) result.orgsMalformed++;
      result.periodsConsidered += org.periodsConsidered;
      result.remindersSent += org.remindersSent;
    });

    return result;
  }

  /** Returns null for an organisation that has no timesheet settings at all. */
  async remindOrg(
    orgId: string,
    today: string,
  ): Promise<{ malformed: boolean; periodsConsidered: number; remindersSent: number } | null> {
    const [settings] = await this.db
      .select({
        reminderRules: timesheetSettings.reminderRules,
        submissionGraceDays: timesheetSettings.submissionGraceDays,
      })
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);
    if (!settings) return null;

    const { rules, malformed } = resolveReminderRules(settings.reminderRules);
    if (malformed) {
      this.logger.warn(
        `org ${orgId} has reminder_rules that do not parse; treating as no reminders. ` +
          `Re-save the timesheet settings to fix.`,
      );
    }
    if (!rules.enabled) return { malformed, periodsConsidered: 0, remindersSent: 0 };

    /**
     * Only periods whose window has closed and which nobody has submitted.
     * `submittedAt IS NULL` rather than a status check: a period can be OPEN
     * and already submitted in flows that reopen it, and reminding someone
     * about a timesheet they have already sent is worse than not reminding.
     */
    const periods = await this.db
      .select({
        id: timesheetPeriods.id,
        userId: timesheetPeriods.userId,
        periodStart: timesheetPeriods.periodStart,
        periodEnd: timesheetPeriods.periodEnd,
      })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.orgId, orgId),
          eq(timesheetPeriods.status, "OPEN"),
          isNull(timesheetPeriods.submittedAt),
          lte(timesheetPeriods.periodEnd, today),
        ),
      );

    let remindersSent = 0;
    for (const period of periods) {
      const due = dueDateFor(period.periodEnd, settings.submissionGraceDays);
      const kind = reminderDue(rules, due, today);
      if (!kind) continue;

      await this.notifications.emit({
        orgId,
        eventKey: EVENT_KEY[kind],
        targetUserIds: [period.userId],
        entityType: "timesheet_period",
        entityId: String(period.id),
        title:
          kind === "OVERDUE"
            ? `Timesheet overdue: ${period.periodStart} to ${period.periodEnd}`
            : `Timesheet due ${due}: ${period.periodStart} to ${period.periodEnd}`,
        message:
          kind === "OVERDUE"
            ? `Your timesheet for ${period.periodStart}–${period.periodEnd} was due on ${due} and has not been submitted.`
            : `Your timesheet for ${period.periodStart}–${period.periodEnd} is due on ${due}.`,
        link: `/timesheets/my-time?period=${period.id}`,
        variables: {
          periodId: period.id,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          dueDate: due,
        },
      });
      remindersSent++;
    }

    return { malformed, periodsConsidered: periods.length, remindersSent };
  }
}
