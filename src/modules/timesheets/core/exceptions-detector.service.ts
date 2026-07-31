import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  organizationMembers,
  timerSessions,
  timesheetExceptions,
  timesheetPeriods,
  timesheetSettings,
  timesheets,
  users,
} from "../../../db/schema";
import { logger } from "../../../common/logger/logger.service";
import { formatDateOnly } from "./lib/period.helpers";
import { addDays, lastCompleteWeekRange } from "./lib/exception-window";

type ExceptionCandidate = typeof timesheetExceptions.$inferInsert;

const STALE_TIMER_MS = 24 * 60 * 60 * 1000;
const MISSING_RATE_LOOKBACK_DAYS = 30;
const INSERT_CHUNK_SIZE = 200;

@Injectable()
export class ExceptionsDetectorService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Scan one org for timesheet data-quality issues and write OPEN exceptions.
   * Idempotent: the partial unique index on
   * (org_id, user_id, rule, COALESCE(period_id,-1), COALESCE(entry_id,-1)) WHERE status='OPEN'
   * plus onConflictDoNothing() means re-runs never duplicate open exceptions.
   */
  async detectForOrg(orgId: string) {
    const [settings] = await this.db
      .select()
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);

    const workWeekStart = settings?.workWeekStart ?? 1;
    const week = lastCompleteWeekRange(new Date(), workWeekStart);
    const expectedWeeklyHours = settings?.expectedWeeklyHours
      ? parseFloat(settings.expectedWeeklyHours)
      : null;
    const maxHoursPerDay = parseFloat(settings?.maxHoursPerDay ?? "24");
    const graceDays = settings?.submissionGraceDays ?? 0;

    const candidates: ExceptionCandidate[] = [];

    // Shared lookups for the last complete week.
    const periods = await this.db
      .select({
        id: timesheetPeriods.id,
        userId: timesheetPeriods.userId,
        status: timesheetPeriods.status,
        totalHours: timesheetPeriods.totalHours,
      })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.orgId, orgId),
          eq(timesheetPeriods.periodStart, week.start),
          eq(timesheetPeriods.periodEnd, week.end),
        ),
      );
    const periodByUser = new Map(periods.map((p) => [p.userId, p]));

    const entryCounts = await this.db
      .select({
        userId: timesheets.userId,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(timesheets)
      .where(
        and(
          eq(timesheets.orgId, orgId),
          gte(timesheets.date, week.start),
          lte(timesheets.date, week.end),
          isNull(timesheets.voidedAt),
        ),
      )
      .groupBy(timesheets.userId);
    const entryCountByUser = new Map(entryCounts.map((r) => [r.userId, r.count]));

    // MISSING_TIMESHEET — active members with no submitted period and no entries.
    const members = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(users.isActive, true),
          eq(users.userStatus, "active"),
        ),
      );

    for (const member of members) {
      const period = periodByUser.get(member.userId);
      const hasEntries = (entryCountByUser.get(member.userId) ?? 0) > 0;
      const periodMissingOrUnsubmitted =
        !period || period.status === "OPEN" || period.status === "DRAFT";
      if (periodMissingOrUnsubmitted && !hasEntries) {
        candidates.push({
          orgId,
          userId: member.userId,
          periodId: period?.id ?? null,
          entryId: null,
          rule: "MISSING_TIMESHEET",
          severity: "ERROR",
          status: "OPEN",
          message: `No timesheet submitted for the week of ${week.start} to ${week.end}`,
          details: { weekStart: week.start, weekEnd: week.end },
          ownerUserId: member.userId,
          dueDate: addDays(week.end, graceDays),
        });
      }
    }

    // UNDER_HOURS — period exists but logged less than the expected weekly hours.
    if (expectedWeeklyHours !== null) {
      for (const period of periods) {
        const actual = parseFloat(period.totalHours);
        if (actual < expectedWeeklyHours) {
          candidates.push({
            orgId,
            userId: period.userId,
            periodId: period.id,
            entryId: null,
            rule: "UNDER_HOURS",
            severity: "WARNING",
            status: "OPEN",
            message: `Logged ${actual}h of the expected ${expectedWeeklyHours}h for the week of ${week.start}`,
            details: { expected: expectedWeeklyHours, actual },
            ownerUserId: period.userId,
          });
        }
      }
    }

    // OVER_MAX_DAILY — any day in the last complete week over the daily cap.
    const dailyTotals = await this.db
      .select({
        userId: timesheets.userId,
        date: timesheets.date,
        total: sql<string>`SUM(${timesheets.hours}::numeric)::text`,
      })
      .from(timesheets)
      .where(
        and(
          eq(timesheets.orgId, orgId),
          gte(timesheets.date, week.start),
          lte(timesheets.date, week.end),
          isNull(timesheets.voidedAt),
        ),
      )
      .groupBy(timesheets.userId, timesheets.date);

    for (const day of dailyTotals) {
      const total = parseFloat(day.total);
      if (total > maxHoursPerDay) {
        candidates.push({
          orgId,
          userId: day.userId,
          periodId: periodByUser.get(day.userId)?.id ?? null,
          entryId: null,
          rule: "OVER_MAX_DAILY",
          severity: "ERROR",
          status: "OPEN",
          message: `Logged ${total}h on ${day.date}, over the daily limit of ${maxHoursPerDay}h`,
          details: { date: day.date, total, limit: maxHoursPerDay },
          ownerUserId: day.userId,
        });
      }
    }

    // UNRESOLVED_TIMER — running/paused timers started more than 24h ago.
    const staleCutoff = new Date(Date.now() - STALE_TIMER_MS);
    const staleTimers = await this.db
      .select({
        id: timerSessions.id,
        userId: timerSessions.userId,
        status: timerSessions.status,
        startedAt: timerSessions.startedAt,
      })
      .from(timerSessions)
      .where(
        and(
          eq(timerSessions.orgId, orgId),
          inArray(timerSessions.status, ["RUNNING", "PAUSED"]),
          lt(timerSessions.startedAt, staleCutoff),
        ),
      );

    for (const timer of staleTimers) {
      candidates.push({
        orgId,
        userId: timer.userId,
        periodId: null,
        entryId: null,
        rule: "UNRESOLVED_TIMER",
        severity: "WARNING",
        status: "OPEN",
        message: `Timer #${timer.id} has been ${timer.status.toLowerCase()} since ${timer.startedAt.toISOString()}`,
        details: { timerId: timer.id, startedAt: timer.startedAt.toISOString() },
        ownerUserId: timer.userId,
      });
    }

    // MISSING_RATE — approved billable entries in the last 30 days with no bill rate.
    const rateSince = addDays(formatDateOnly(new Date()), -MISSING_RATE_LOOKBACK_DAYS);
    const missingRateEntries = await this.db
      .select({
        id: timesheets.id,
        userId: timesheets.userId,
        date: timesheets.date,
        projectId: timesheets.projectId,
        timesheetPeriodId: timesheets.timesheetPeriodId,
      })
      .from(timesheets)
      .where(
        and(
          eq(timesheets.orgId, orgId),
          eq(timesheets.status, "APPROVED"),
          eq(timesheets.isBillable, true),
          isNull(timesheets.billRate),
          isNull(timesheets.voidedAt),
          gte(timesheets.date, rateSince),
        ),
      );

    for (const entry of missingRateEntries) {
      candidates.push({
        orgId,
        userId: entry.userId,
        periodId: entry.timesheetPeriodId,
        entryId: entry.id,
        rule: "MISSING_RATE",
        severity: "WARNING",
        status: "OPEN",
        message: `Approved billable entry on ${entry.date} has no bill rate`,
        details: { entryId: entry.id, date: entry.date, projectId: entry.projectId },
        ownerUserId: entry.userId,
      });
    }

    // Dedupe within this batch on the same key as the partial unique index, so
    // a multi-row insert cannot conflict with itself.
    const seen = new Set<string>();
    const rows = candidates.filter((c) => {
      const key = `${c.userId}|${c.rule}|${c.periodId ?? -1}|${c.entryId ?? -1}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let created = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
      const inserted = await this.db
        .insert(timesheetExceptions)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ id: timesheetExceptions.id });
      created += inserted.length;
    }

    return { week, candidates: rows.length, created };
  }

  /** Run detection for every org that has timesheet settings configured. */
  async detectAllOrgs() {
    const orgs = await this.db
      .selectDistinct({ orgId: timesheetSettings.orgId })
      .from(timesheetSettings);

    let orgsScanned = 0;
    let created = 0;
    for (const org of orgs) {
      try {
        const result = await this.detectForOrg(org.orgId);
        created += result.created;
        orgsScanned++;
      } catch (error) {
        logger.error(`Timesheet exception detection failed for org ${org.orgId}`, error);
      }
    }

    return { orgsScanned, created };
  }
}
