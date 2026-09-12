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
import { forEachOrg } from "../../../common/tenant";
import { formatDateOnly } from "./lib/period.helpers";
import { addDays, lastCompleteWeekRange } from "./lib/exception-window";

type ExceptionCandidate = typeof timesheetExceptions.$inferInsert;

const STALE_TIMER_MS = 24 * 60 * 60 * 1000;
const MISSING_RATE_LOOKBACK_DAYS = 30;
const INSERT_CHUNK_SIZE = 200;

@Injectable()
export class ExceptionsDetectorService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
      : settings?.expectedDailyHours
        ? parseFloat(settings.expectedDailyHours) * 5
        : null;
    const maxHoursPerDay = parseFloat(settings?.maxHoursPerDay ?? "24");
    const graceDays = settings?.submissionGraceDays ?? 0;

    const candidates: ExceptionCandidate[] = [];

    const periods = await this.db
      .select({
        id: timesheetPeriods.id,
        userMembershipId: timesheetPeriods.userMembershipId,
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
    const periodByUser = new Map(periods.map((p) => [p.userMembershipId, p]));

    const entryCounts = await this.db
      .select({
        userMembershipId: timesheets.userMembershipId,
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
      .groupBy(timesheets.userMembershipId);
    const entryCountByUser = new Map(entryCounts.map((r) => [r.userMembershipId, r.count]));

    const members = await this.db
      .select({ id: organizationMembers.id })
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
      const period = periodByUser.get(member.id);
      const hasEntries = (entryCountByUser.get(member.id) ?? 0) > 0;
      const periodMissingOrUnsubmitted =
        !period || period.status === "OPEN" || period.status === "DRAFT";
      if (periodMissingOrUnsubmitted && !hasEntries) {
        candidates.push({
          orgId,
          userMembershipId: member.id,
          periodId: period?.id ?? null,
          entryId: null,
          rule: "MISSING_TIMESHEET",
          severity: "ERROR",
          status: "OPEN",
          message: `No timesheet submitted for the week of ${week.start} to ${week.end}`,
          details: { weekStart: week.start, weekEnd: week.end },
          ownerMembershipId: member.id,
          dueDate: addDays(week.end, graceDays),
        });
      }
    }

    if (expectedWeeklyHours !== null) {
      for (const period of periods) {
        const actual = parseFloat(period.totalHours);
        if (actual < expectedWeeklyHours) {
          candidates.push({
            orgId,
            userMembershipId: period.userMembershipId,
            periodId: period.id,
            entryId: null,
            rule: "UNDER_HOURS",
            severity: "WARNING",
            status: "OPEN",
            message: `Logged ${actual}h of the expected ${expectedWeeklyHours}h for the week of ${week.start}`,
            details: { expected: expectedWeeklyHours, actual },
            ownerMembershipId: period.userMembershipId,
          });
        }
      }
    }

    const dailyTotals = await this.db
      .select({
        userMembershipId: timesheets.userMembershipId,
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
      .groupBy(timesheets.userMembershipId, timesheets.date);

    for (const day of dailyTotals) {
      const total = parseFloat(day.total);
      if (total > maxHoursPerDay) {
        candidates.push({
          orgId,
          userMembershipId: day.userMembershipId,
          periodId: periodByUser.get(day.userMembershipId)?.id ?? null,
          entryId: null,
          rule: "OVER_MAX_DAILY",
          severity: "ERROR",
          status: "OPEN",
          message: `Logged ${total}h on ${day.date}, over the daily limit of ${maxHoursPerDay}h`,
          details: { date: day.date, total, limit: maxHoursPerDay },
          ownerMembershipId: day.userMembershipId,
        });
      }
    }

    const staleCutoff = new Date(Date.now() - STALE_TIMER_MS);
    const staleTimers = await this.db
      .select({
        id: timerSessions.id,
        userMembershipId: timerSessions.userMembershipId,
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
        userMembershipId: timer.userMembershipId,
        periodId: null,
        entryId: null,
        rule: "UNRESOLVED_TIMER",
        severity: "WARNING",
        status: "OPEN",
        message: `Timer #${timer.id} has been ${timer.status.toLowerCase()} since ${timer.startedAt.toISOString()}`,
        details: { timerId: timer.id, startedAt: timer.startedAt.toISOString() },
        ownerMembershipId: timer.userMembershipId,
      });
    }

    const rateSince = addDays(formatDateOnly(new Date()), -MISSING_RATE_LOOKBACK_DAYS);
    const missingRateEntries = await this.db
      .select({
        id: timesheets.id,
        userMembershipId: timesheets.userMembershipId,
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
        userMembershipId: entry.userMembershipId,
        periodId: entry.timesheetPeriodId,
        entryId: entry.id,
        rule: "MISSING_RATE",
        severity: "WARNING",
        status: "OPEN",
        message: `Approved billable entry on ${entry.date} has no bill rate`,
        details: { entryId: entry.id, date: entry.date, projectId: entry.projectId },
        ownerMembershipId: entry.userMembershipId,
      });
    }

    const seen = new Set<string>();
    const rows = candidates.filter((c) => {
      const key = `${c.userMembershipId ?? ""}|${c.rule}|${c.periodId ?? -1}|${c.entryId ?? -1}`;
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

  async detectAllOrgs() {
    let orgsScanned = 0;
    let created = 0;

    await forEachOrg(this.db, "timesheets-exception-detection", async (_tx, orgId) => {
      const [hasSettings] = await this.db
        .select({ orgId: timesheetSettings.orgId })
        .from(timesheetSettings)
        .where(eq(timesheetSettings.orgId, orgId))
        .limit(1);
      if (!hasSettings) return;
      const result = await this.detectForOrg(orgId);
      created += result.created;
      orgsScanned++;
    });

    return { orgsScanned, created };
  }
}
