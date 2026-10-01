import { Inject, Injectable, ForbiddenException } from "@nestjs/common";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheets, timesheetSettings, holidays, leaveRequests, users, organizationMembers } from "../../../db/schema";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { membershipTeamScope } from "../core/timesheets-core-scope";
import type { ScopedRead } from "../../access/scoped-read";
import { computeLeaveDays, computeOvertime, isWeekend, round2 } from "./lib/payroll-calc";
import type { PeriodSummaryQuery, PayrollSummaryRow } from "./dto/payroll.schemas";

interface RawEntry {
  userId: string;
  date: string;
  hours: string;
  isBillable: boolean;
  status: string;
  payrollStatus: string;
  userName: string | null;
  userEmail: string;
}

function buildRows(
  entries: RawEntry[],
  holidayDates: Set<string>,
  leavesByUser: Map<string, number>,
  dailyThreshold: number,
  weeklyThreshold: number,
  includeExported: boolean,
  includeNonBillable: boolean,
): PayrollSummaryRow[] {
  const byUser = new Map<string, RawEntry[]>();
  for (const e of entries) {
    const arr = byUser.get(e.userId) ?? [];
    arr.push(e);
    byUser.set(e.userId, arr);
  }

  const rows: PayrollSummaryRow[] = [];
  for (const [userId, userEntries] of byUser) {
    const approved = userEntries.filter((e) => e.status === "APPROVED");
    const pending = userEntries.filter((e) => e.status === "PENDING");
    const exported = approved.filter((e) => e.payrollStatus === "EXPORTED");
    const unprocessed = approved.filter((e) => e.payrollStatus === "UNPROCESSED");
    const payablePool = includeExported ? approved : unprocessed;
    const payable = includeNonBillable ? payablePool : payablePool.filter((e) => e.isBillable);

    let totalPayableHours = 0;
    let billableHours = 0;
    let nonBillableHours = 0;
    let holidayHours = 0;
    let weekendHours = 0;

    for (const e of payable) {
      const h = parseFloat(e.hours);
      totalPayableHours += h;
      if (e.isBillable) billableHours += h;
      else nonBillableHours += h;
      if (holidayDates.has(e.date)) holidayHours += h;
      if (isWeekend(e.date)) weekendHours += h;
    }

    let exportedHours = 0;
    for (const e of exported) exportedHours += parseFloat(e.hours);

    let pendingHours = 0;
    for (const e of pending) pendingHours += parseFloat(e.hours);

    const otEntries = payable.map((e) => ({ date: e.date, hours: parseFloat(e.hours) }));
    const overtimeHours = computeOvertime(otEntries, dailyThreshold, weeklyThreshold);
    const regularHours = totalPayableHours - overtimeHours;

    const first = userEntries[0];
    const userName = first?.userName ?? first?.userEmail ?? "Former user";
    const userEmail = first?.userEmail ?? "";

    rows.push({
      userId,
      userName,
      userEmail,
      regularHours: round2(regularHours),
      overtimeHours: round2(overtimeHours),
      holidayHours: round2(holidayHours),
      weekendHours: round2(weekendHours),
      breakHours: 0,
      leaveDays: round2(leavesByUser.get(userId) ?? 0),
      billableHours: round2(billableHours),
      nonBillableHours: round2(nonBillableHours),
      totalPayableHours: round2(totalPayableHours),
      entryCount: payable.length,
      exportedHours: round2(exportedHours),
      hasPendingEntries: pending.length > 0,
      pendingHours: round2(pendingHours),
    });
  }

  rows.sort((a, b) => a.userName.localeCompare(b.userName));
  return rows;
}

@Injectable()
export class PayrollSummaryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getPeriodSummary(read: ScopedRead, query: PeriodSummaryQuery) {
    if (query.userId && query.userId !== read.actorId && read.discriminator !== "all") {
      throw new ForbiddenException("Not authorized to filter payroll summary for another user");
    }

    const hash = `${query.start}-${query.end}-${query.userId ?? ""}-${query.includeExported}-${read.discriminator}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.payrollSummaryNamespace(read.orgId),
      hash,
      () => this.compute(read, query),
      CACHE_TTL.SHORT,
    );
  }

  private async compute(read: ScopedRead, query: PeriodSummaryQuery) {
    const orgId = read.orgId;
    const actorUserId = read.actorId;
    const [settings] = await this.db
      .select({
        overtimeDailyHours: timesheetSettings.overtimeDailyHours,
        overtimeWeeklyHours: timesheetSettings.overtimeWeeklyHours,
        includeNonBillable: timesheetSettings.includeNonBillable,
      })
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);

    const dailyThreshold = parseFloat(settings?.overtimeDailyHours ?? "8");
    const weeklyThreshold = parseFloat(settings?.overtimeWeeklyHours ?? "40");
    const includeNonBillable = settings?.includeNonBillable ?? true;

    const [actorMember] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, actorUserId)))
      .limit(1);
    const actorMembId = actorMember?.id ?? null;

    const ownerMember = alias(organizationMembers, "owner_member");

    let requestedMembershipId: number | undefined;
    if (query.userId && read.discriminator === "all") {
      const [qm] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, query.userId)))
        .limit(1);
      if (qm) requestedMembershipId = qm.id;
    }

    const entries: RawEntry[] = await read.read(
      {
        tenant: timesheets.orgId,
        scope: membershipTeamScope(orgId, actorUserId, actorMembId, timesheets.userMembershipId),
        and: [
          gte(timesheets.date, query.start),
          lte(timesheets.date, query.end),
          requestedMembershipId !== undefined ? eq(timesheets.userMembershipId, requestedMembershipId) : undefined,
        ],
      },
      ({ sql: where }) =>
        this.db
          .select({
            userId: ownerMember.userId,
            date: timesheets.date,
            hours: timesheets.hours,
            isBillable: timesheets.isBillable,
            status: timesheets.status,
            payrollStatus: timesheets.payrollStatus,
            userName: users.name,
            userEmail: users.email,
          })
          .from(timesheets)
          .innerJoin(ownerMember, and(eq(timesheets.orgId, ownerMember.orgId), eq(timesheets.userMembershipId, ownerMember.id)))
          .innerJoin(users, eq(ownerMember.userId, users.id))
          .where(where),
      () => [],
    );

    const holidayRows = await this.db
      .select({ date: holidays.date })
      .from(holidays)
      .where(and(eq(holidays.orgId, orgId), gte(holidays.date, query.start), lte(holidays.date, query.end)));

    const holidayDates = new Set(holidayRows.map((h) => h.date));

    const leaveWhere = read.compose(
      {
        tenant: leaveRequests.orgId,
        scope: { columns: { ownerColumn: leaveRequests.userId } },
        and: [
          eq(leaveRequests.status, "APPROVED"),
          lte(leaveRequests.startDate, query.end),
          gte(leaveRequests.endDate, query.start),
          query.userId && read.discriminator === "all" ? eq(leaveRequests.userId, query.userId) : undefined,
        ],
      },
      ({ sql: w }) => w,
      () => sql`false`,
    );

    const leaveRows = await this.db
      .select({
        userId: leaveRequests.userId,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        isHalfDay: leaveRequests.isHalfDay,
      })
      .from(leaveRequests)
      .where(leaveWhere);

    const leavesByUser = computeLeaveDays(leaveRows, query.start, query.end);
    const rows = buildRows(entries, holidayDates, leavesByUser, dailyThreshold, weeklyThreshold, query.includeExported, includeNonBillable);

    let payableHours = 0, regularHours = 0, overtimeHours = 0, holidayHoursTotal = 0;
    let weekendHoursTotal = 0, billableHoursTotal = 0, nonBillableHoursTotal = 0;
    let exportedHoursTotal = 0, pendingApprovalHours = 0, pendingApprovalCount = 0;
    const userIds = new Set<string>();
    const pendingUserIds = new Set<string>();

    for (const row of rows) {
      userIds.add(row.userId);
      payableHours += row.totalPayableHours;
      regularHours += row.regularHours;
      overtimeHours += row.overtimeHours;
      holidayHoursTotal += row.holidayHours;
      weekendHoursTotal += row.weekendHours;
      billableHoursTotal += row.billableHours;
      nonBillableHoursTotal += row.nonBillableHours;
      exportedHoursTotal += row.exportedHours;
      if (row.hasPendingEntries) {
        pendingApprovalHours += row.pendingHours;
        pendingApprovalCount += entries.filter((e) => e.userId === row.userId && e.status === "PENDING").length;
        pendingUserIds.add(row.userId);
      }
    }

    const pendingApprovals = rows
      .filter((r) => r.hasPendingEntries)
      .map((r) => ({
        userId: r.userId,
        userName: r.userName,
        entryCount: entries.filter((e) => e.userId === r.userId && e.status === "PENDING").length,
        hours: r.pendingHours,
      }));

    return {
      period: { start: query.start, end: query.end },
      totals: {
        payableHours: round2(payableHours),
        regularHours: round2(regularHours),
        overtimeHours: round2(overtimeHours),
        holidayHours: round2(holidayHoursTotal),
        weekendHours: round2(weekendHoursTotal),
        breakHours: 0,
        billableHours: round2(billableHoursTotal),
        nonBillableHours: round2(nonBillableHoursTotal),
        userCount: userIds.size,
        entryCount: rows.reduce((s, r) => s + r.entryCount, 0),
        exportedHours: round2(exportedHoursTotal),
        pendingApprovalHours: round2(pendingApprovalHours),
        pendingApprovalCount,
        pendingUserCount: pendingUserIds.size,
      },
      rows,
      exceptions: { pendingApprovals },
    };
  }
}
