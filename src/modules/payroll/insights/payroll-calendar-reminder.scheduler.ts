import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollCalendarEvents,
  organizationMembers,
  payrollSchedulerState,
} from "../../../db/schema";
import { PayrollNotificationsService } from "./payroll-notifications.service";
import { logger } from "../../../common/logger/logger.service";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_WINDOW_DAYS = 3;
const JOB_NAME = "payroll.calendar_reminders";

function msUntilNextEightAM(): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(8, 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/**
 * Calendar reminder scheduler. Process timers only wake instances; the actual
 * daily run is claimed atomically in payroll_scheduler_state, so exactly one
 * instance sends reminders per day and a boot after a missed 8AM catches up.
 */
@Injectable()
export class PayrollCalendarReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: PayrollNotificationsService,
  ) {}

  onModuleInit(): void {
    void this.run();
    this.timeout = setTimeout(() => {
      void this.run();
      this.interval = setInterval(() => {
        void this.run();
      }, ONE_DAY_MS);
    }, msUntilNextEightAM());
  }

  onModuleDestroy(): void {
    clearTimeout(this.timeout);
    clearInterval(this.interval);
  }

  private async claimDailyRun(): Promise<boolean> {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    await this.db
      .insert(payrollSchedulerState)
      .values({ jobName: JOB_NAME })
      .onConflictDoNothing();

    const claimed = await this.db
      .update(payrollSchedulerState)
      .set({
        lastStartedAt: now,
        lastError: null,
        runCount: sql`${payrollSchedulerState.runCount} + 1`,
      })
      .where(
        and(
          eq(payrollSchedulerState.jobName, JOB_NAME),
          or(
            isNull(payrollSchedulerState.lastStartedAt),
            lt(payrollSchedulerState.lastStartedAt, startOfDay),
          ),
        ),
      )
      .returning({ jobName: payrollSchedulerState.jobName });

    return claimed.length > 0;
  }

  private async markFinished(error: string | null): Promise<void> {
    const now = new Date();
    await this.db
      .update(payrollSchedulerState)
      .set({
        lastFinishedAt: now,
        lastSuccessAt: error ? undefined : now,
        lastError: error,
      })
      .where(eq(payrollSchedulerState.jobName, JOB_NAME));
  }

  async run(): Promise<void> {
    if (!(await this.claimDailyRun())) return;
    try {
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10);
      const windowEnd = new Date(today.getTime() + REMINDER_WINDOW_DAYS * ONE_DAY_MS);
      const windowEndStr = windowEnd.toISOString().slice(0, 10);

      const events = await this.db
        .select({
          id: payrollCalendarEvents.id,
          orgId: payrollCalendarEvents.orgId,
          title: payrollCalendarEvents.title,
          date: payrollCalendarEvents.date,
        })
        .from(payrollCalendarEvents)
        .where(
          and(
            gte(payrollCalendarEvents.date, todayStr),
            lte(payrollCalendarEvents.date, windowEndStr),
          ),
        )
        .limit(5000);

      if (events.length === 0) {
        await this.markFinished(null);
        return;
      }

      const orgIds = [...new Set(events.map((e) => e.orgId))];

      const ownerRows = await this.db
        .select({ orgId: organizationMembers.orgId, userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            inArray(organizationMembers.orgId, orgIds),
            eq(organizationMembers.isOwner, true),
          ),
        );

      const ownersByOrg = new Map<string, string[]>();
      for (const row of ownerRows) {
        const existing = ownersByOrg.get(row.orgId);
        if (existing !== undefined) {
          existing.push(row.userId);
        } else {
          ownersByOrg.set(row.orgId, [row.userId]);
        }
      }

      for (const event of events) {
        const userIds = ownersByOrg.get(event.orgId) ?? [];
        for (const userId of userIds) {
          await this.notifications.remindCalendarEvent(
            event.orgId,
            userId,
            event.id,
            event.title,
            event.date,
          );
        }
      }
      await this.markFinished(null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("PayrollCalendarReminderScheduler: run failed", { error: msg });
      await this.markFinished(msg).catch(() => undefined);
    }
  }
}
