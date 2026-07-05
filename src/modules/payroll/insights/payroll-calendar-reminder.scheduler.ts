import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollCalendarEvents, organizationMembers } from "../../../db/schema";
import { PayrollNotificationsService } from "./payroll-notifications.service";
import { logger } from "../../../common/logger/logger.service";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_WINDOW_DAYS = 3;

function msUntilNextEightAM(): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(8, 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

@Injectable()
export class PayrollCalendarReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: PayrollNotificationsService,
  ) {}

  onModuleInit(): void {
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

  private async run(): Promise<void> {
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
        );

      if (events.length === 0) return;

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
    } catch (error) {
      logger.error("PayrollCalendarReminderScheduler: run failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
