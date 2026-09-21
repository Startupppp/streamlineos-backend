import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { organizationMembers, timesheetPeriods, timesheetSettings } from "../../../db/schema";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { NotificationEventKey } from "../../notifications/notification-events.catalog";
import {
  dueDateFor,
  reminderDue,
  resolveReminderRules,
  type ReminderKind,
} from "./dto/reminder-rules.schemas";

const EVENT_KEY = {
  DUE_SOON: "timesheets.period.due_soon",
  OVERDUE: "timesheets.period.overdue",
} as const satisfies Record<ReminderKind, NotificationEventKey>;

export interface ReminderSweepResult {
  orgsScanned: number;
  orgsMalformed: number;
  periodsConsidered: number;
  remindersSent: number;
  orgsTruncated: number;
}

const REMINDER_PAGE_SIZE = 500;
const REMINDER_MAX_PAGES = 40;

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
      orgsTruncated: 0,
    };

    await forEachOrg(this.db, "timesheets-reminders", async (_tx, orgId) => {
      const org = await this.remindOrg(orgId, today);
      if (!org) return;
      result.orgsScanned++;
      if (org.malformed) result.orgsMalformed++;
      result.periodsConsidered += org.periodsConsidered;
      result.remindersSent += org.remindersSent;
      if (org.truncated) result.orgsTruncated++;
    });

    return result;
  }

  async remindOrg(
    orgId: string,
    today: string,
  ): Promise<{
    malformed: boolean;
    periodsConsidered: number;
    remindersSent: number;
    truncated: boolean;
  } | null> {
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
    if (!rules.enabled) {
      return { malformed, periodsConsidered: 0, remindersSent: 0, truncated: false };
    }

    let remindersSent = 0;
    let periodsConsidered = 0;
    let truncated = false;
    let afterId = 0;

    for (let page = 0; page < REMINDER_MAX_PAGES; page++) {
      const periods = await this.db
        .select({
          id: timesheetPeriods.id,
          userMembershipId: timesheetPeriods.userMembershipId,
          userId: organizationMembers.userId,
          periodStart: timesheetPeriods.periodStart,
          periodEnd: timesheetPeriods.periodEnd,
        })
        .from(timesheetPeriods)
        .leftJoin(
          organizationMembers,
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.id, timesheetPeriods.userMembershipId),
          ),
        )
        .where(
          and(
            eq(timesheetPeriods.orgId, orgId),
            eq(timesheetPeriods.status, "OPEN"),
            isNull(timesheetPeriods.submittedAt),
            lte(timesheetPeriods.periodEnd, today),
            gt(timesheetPeriods.id, afterId),
          ),
        )
        .orderBy(asc(timesheetPeriods.id))
        .limit(REMINDER_PAGE_SIZE);

      if (periods.length === 0) break;
      periodsConsidered += periods.length;
      afterId = periods[periods.length - 1]!.id;

      remindersSent += await this.remindPage(orgId, periods, settings.submissionGraceDays, rules, today);

      if (periods.length < REMINDER_PAGE_SIZE) break;
      if (page === REMINDER_MAX_PAGES - 1) {
        truncated = true;
        this.logger.warn(
          `org ${orgId} still had unsubmitted periods after ${REMINDER_MAX_PAGES * REMINDER_PAGE_SIZE}; ` +
            `stopping this pass. The rest will be picked up on the next run.`,
        );
      }
    }

    return { malformed, periodsConsidered, remindersSent, truncated };
  }

  private async remindPage(
    orgId: string,
    periods: Array<{
      id: number;
      userMembershipId: number | null;
      userId: string | null;
      periodStart: string;
      periodEnd: string;
    }>,
    graceDays: number | null,
    rules: ReturnType<typeof resolveReminderRules>["rules"],
    today: string,
  ): Promise<number> {
    let remindersSent = 0;
    for (const period of periods) {
      const due = dueDateFor(period.periodEnd, graceDays);
      const kind = reminderDue(rules, due, today);
      if (!kind) continue;

      if (!period.userId) {
        this.logger.warn(
          `org ${orgId} period ${period.id}: owner membership ${period.userMembershipId ?? "(none)"} ` +
            `does not resolve to a user in this organisation; ${kind} reminder skipped.`,
        );
        continue;
      }

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

    return remindersSent;
  }
}
