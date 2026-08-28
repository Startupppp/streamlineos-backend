import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  gte,
  isNull,
  lt,
  or,
  sql,
  sum,
} from "drizzle-orm";
import {
  attendance,
  calendarEvents,
  hrEmployments,
  hrPeople,
  leaveBalances,
  leaveTypes,
  notifications,
  organizationMembers,
  organizations,
  projects,
  tickets,
  timesheets,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { applyScope } from "../access/apply-scope";
import { getTodayString } from "../../common/date";
import {
  resolveDashboardStatsFlags,
  resolvePersonalDashboardModules,
} from "./dashboard-scope";
import { resolveAttendanceReadScope } from "../hr/time/attendance-scope";
import {
  buildOrgDashboardCacheKey,
  buildScopedDashboardCacheKey,
} from "./dashboard-cache-key";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../directory/employment-query";

export interface BirthdayEntry {
  id: string;
  name: string | null;
  designation: string | null;
  image: string | null;
  type: "birthday" | "anniversary";
  date: string;
  yearsCompleted?: number;
}

@Injectable()
export class DashboardHrService {
  private readonly logger = new Logger(DashboardHrService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async getDashboardStats(orgId: string, u: CurrentUserContext) {
    const [statsKey, flags] = await Promise.all([
      buildOrgDashboardCacheKey(this.access, orgId, "stats"),
      resolveDashboardStatsFlags(this.access, u),
    ]);

    const full = await this.cache.cached(
      statsKey,
      async () => {
        const today = getTodayString();
        const [
          org,
          memberCountResult,
          projectCountResult,
          attendanceCountResult,
        ] = await Promise.all([
          this.db.query.organizations.findFirst({
            where: eq(organizations.id, orgId),
          }),
          this.db
            .select({ count: count() })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.status, "ACTIVE"),
              ),
            ),
          this.db
            .select({ count: count() })
            .from(projects)
            .where(
              and(eq(projects.orgId, orgId), isNull(projects.deletedAt)),
            ),
          this.db
            .select({ count: count() })
            .from(attendance)
            .where(
              and(eq(attendance.orgId, orgId), eq(attendance.date, today)),
            ),
        ]);

        return {
          orgName: org?.name || "Organization",
          totalEmployees: Number(memberCountResult[0]?.count || 0),
          activeProjects: Number(projectCountResult[0]?.count || 0),
          presentToday: Number(attendanceCountResult[0]?.count || 0),
          orgSlug: org?.slug || orgId.slice(0, 8),
        };
      },
      CACHE_TTL.SHORT,
    );

    return {
      orgName: full.orgName,
      orgSlug: full.orgSlug,
      totalEmployees: flags.employees ? full.totalEmployees : null,
      presentToday: flags.attendance ? full.presentToday : null,
      activeProjects: flags.projects ? full.activeProjects : null,
    };
  }

  async getTeamAvailability(u: CurrentUserContext) {
    const { orgId, userId } = u;
    const scope = await resolveAttendanceReadScope(this.access, u);
    if (scope === "none") return [];
    const today = getTodayString();
    const key = await buildScopedDashboardCacheKey(
      this.access,
      u,
      "availability",
      scope,
      today,
    );
    return this.cache.cached(
      key,
      async () => {
        const scopePredicate = applyScope(scope, orgId, userId, {
          ownerColumn: attendance.userId,
        });
        const todayAttendance = await this.db
          .select({
            userId: attendance.userId,
            checkIn: attendance.checkIn,
            checkOut: attendance.checkOut,
            createdAt: attendance.createdAt,
            userName: users.name,
            firstName: users.firstName,
            lastName: users.lastName,
            userImage: users.image,
          })
          .from(attendance)
          .innerJoin(users, eq(attendance.userId, users.id))
          .where(
            and(
              eq(attendance.orgId, orgId),
              eq(attendance.date, today),
              scopePredicate,
            ),
          );

        const byUser = new Map<string, (typeof todayAttendance)[number]>();
        for (const record of todayAttendance) {
          const existing = byUser.get(record.userId);
          if (!existing) {
            byUser.set(record.userId, record);
            continue;
          }
          const recordOpen = Boolean(record.checkIn) && !record.checkOut;
          const existingOpen = Boolean(existing.checkIn) && !existing.checkOut;
          if (recordOpen && !existingOpen) {
            byUser.set(record.userId, record);
            continue;
          }
          if (recordOpen === existingOpen) {
            const recordCreated = record.createdAt
              ? new Date(record.createdAt).getTime()
              : 0;
            const existingCreated = existing.createdAt
              ? new Date(existing.createdAt).getTime()
              : 0;
            if (recordCreated > existingCreated)
              byUser.set(record.userId, record);
          }
        }

        return [...byUser.values()].map((record) => ({
          userId: record.userId,
          name:
            record.firstName && record.lastName
              ? `${record.firstName} ${record.lastName}`
              : record.userName || "Unknown",
          image: record.userImage,
          checkIn: record.checkIn,
          checkOut: record.checkOut,
          isOnline: Boolean(record.checkIn) && !record.checkOut,
        }));
      },
      CACHE_TTL.SHORT,
    );
  }

  async getTeamAttendance(u: CurrentUserContext) {
    const { orgId } = u;
    const scope = await resolveAttendanceReadScope(this.access, u);
    if (scope === "none")
      return { total: 0, present: 0, clockedIn: 0, absent: 0, records: [] };
    const today = getTodayString();
    const key = await buildScopedDashboardCacheKey(
      this.access,
      u,
      "attendance",
      scope,
      today,
    );
    return this.cache.cached(
      key,
      () => this.buildTeamAttendance(orgId, today, scope, u),
      CACHE_TTL.SHORT,
    );
  }

  private async buildTeamAttendance(
    orgId: string,
    today: string,
    scope: DataScope,
    u: CurrentUserContext,
  ) {
    const memberScopePredicate = applyScope(scope, orgId, u.userId, {
      ownerColumn: organizationMembers.userId,
    });
    const attendanceScopePredicate = applyScope(scope, orgId, u.userId, {
      ownerColumn: attendance.userId,
    });

    const [totalMembersResult, todayAttendance] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.status, "ACTIVE"),
            memberScopePredicate,
          ),
        ),
      this.db
        .select({
          userId: attendance.userId,
          userName: users.name,
          userImage: users.image,
          userDesignation: hrEmployments.designation,
          checkIn: attendance.checkIn,
          checkOut: attendance.checkOut,
          status: attendance.status,
          createdAt: attendance.createdAt,
        })
        .from(attendance)
        .innerJoin(users, eq(attendance.userId, users.id))
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(
          and(
            eq(attendance.orgId, orgId),
            eq(attendance.date, today),
            attendanceScopePredicate,
          ),
        ),
    ]);

    const byUser = new Map<string, (typeof todayAttendance)[number]>();
    for (const record of todayAttendance) {
      const existing = byUser.get(record.userId);
      if (!existing) {
        byUser.set(record.userId, record);
        continue;
      }
      const recordOpen = Boolean(record.checkIn) && !record.checkOut;
      const existingOpen = Boolean(existing.checkIn) && !existing.checkOut;
      if (recordOpen && !existingOpen) {
        byUser.set(record.userId, record);
        continue;
      }
      if (recordOpen === existingOpen) {
        const recordCreated = record.createdAt
          ? new Date(record.createdAt).getTime()
          : 0;
        const existingCreated = existing.createdAt
          ? new Date(existing.createdAt).getTime()
          : 0;
        if (recordCreated > existingCreated) byUser.set(record.userId, record);
      }
    }

    const latestRecords = [...byUser.values()].map((record) => ({
      userId: record.userId,
      userName: record.userName,
      userImage: record.userImage,
      userDesignation: record.userDesignation,
      checkIn: record.checkIn,
      checkOut: record.checkOut,
      status: record.status,
    }));
    const clockedIn = latestRecords.filter(
      (a) => a.checkIn && !a.checkOut,
    ).length;
    const total = totalMembersResult[0]?.count ?? 0;

    return {
      total,
      present: latestRecords.length,
      clockedIn,
      absent: total - latestRecords.length,
      records: latestRecords,
    };
  }

  async getBirthdays(orgId: string): Promise<BirthdayEntry[]> {
    const today = new Date().toISOString().slice(0, 10);
    const key = await buildOrgDashboardCacheKey(
      this.access,
      orgId,
      "birthdays",
      today,
    );
    return this.cache.cached(
      key,
      () => this.buildBirthdays(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildBirthdays(orgId: string): Promise<BirthdayEntry[]> {
    const todayDate = new Date();
    const windowDates = Array.from({ length: 8 }, (_, i) => {
      const d = new Date(todayDate);
      d.setDate(todayDate.getDate() + i);
      return {
        str: d.toISOString().split("T")[0],
        mmdd: `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      };
    });
    const mmddList = windowDates.map((w) => w.mmdd);
    const mmddByDate = new Map(windowDates.map((w) => [w.mmdd, w.str]));

    const mmddValues = sql.join(
      mmddList.map((d) => sql`${d}`),
      sql`, `,
    );

    const [bdayMembers, annivMembers] = await Promise.all([
      this.db
        .select({
          id: users.id,
          name: users.name,
          designation: hrEmployments.designation,
          image: users.image,
          mmdd: sql<string>`to_char(${users.dateOfBirth}::date, 'MM-DD')`,
        })
        .from(users)
        .innerJoin(
          organizationMembers,
          eq(organizationMembers.userId, users.id),
        )
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(users.isActive, true),
            sql`to_char(${users.dateOfBirth}::date, 'MM-DD') IN (${mmddValues})`,
          ),
        )
        .limit(50),

      this.db
        .select({
          id: users.id,
          name: users.name,
          designation: hrEmployments.designation,
          image: users.image,
          joiningDate: hrEmployments.joiningDate,
          mmdd: sql<string>`to_char(${hrEmployments.joiningDate}::date, 'MM-DD')`,
        })
        .from(users)
        .innerJoin(
          organizationMembers,
          eq(organizationMembers.userId, users.id),
        )
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(users.isActive, true),
            sql`to_char(${hrEmployments.joiningDate}::date, 'MM-DD') IN (${mmddValues})`,
            sql`EXTRACT(YEAR FROM age(${hrEmployments.joiningDate}::date)) >= 1`,
          ),
        )
        .limit(50),
    ]);

    const result: BirthdayEntry[] = [];
    const seen = new Set<string>();

    for (const m of bdayMembers) {
      const key = `${m.id}-birthday`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: m.id,
        name: m.name,
        designation: m.designation,
        image: m.image,
        type: "birthday",
        date:
          mmddByDate.get(m.mmdd) ?? todayDate.toISOString().split("T")[0],
      });
    }

    for (const m of annivMembers) {
      const key = `${m.id}-anniversary`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dateStr =
        mmddByDate.get(m.mmdd) ?? todayDate.toISOString().split("T")[0];
      const years = m.joiningDate
        ? new Date(dateStr).getFullYear() -
          new Date(m.joiningDate).getFullYear()
        : 0;
      result.push({
        id: m.id,
        name: m.name,
        designation: m.designation,
        image: m.image,
        type: "anniversary",
        date: dateStr,
        yearsCompleted: years,
      });
    }

    return result.slice(0, 20);
  }

  async getPersonalDashboard(u: CurrentUserContext) {
    const { orgId, userId } = u;
    const modules = await resolvePersonalDashboardModules(this.access, u);
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const degraded: string[] = [];
    const settle = async <T>(
      source: string,
      run: () => Promise<T>,
      fallback: T,
    ): Promise<T> => {
      try {
        return await run();
      } catch (error: unknown) {
        degraded.push(source);
        this.logger.error(
          `Personal dashboard source "${source}" failed for org ${orgId}`,
          error instanceof Error ? error.stack : String(error),
        );
        return fallback;
      }
    };

    const [
      myTasks,
      timesheetRows,
      leaveBalanceRows,
      upcomingEvents,
      unreadCount,
    ] = await Promise.all([
      modules.build
        ? settle(
            "myTasks",
            () =>
              this.db.query.tickets.findMany({
                where: and(
                  eq(tickets.orgId, orgId),
                  eq(tickets.assigneeId, userId),
                  isNull(tickets.deletedAt),
                  or(
                    eq(tickets.status, "TODO"),
                    eq(tickets.status, "IN_PROGRESS"),
                    eq(tickets.status, "IN_REVIEW"),
                  ),
                ),
                orderBy: [desc(tickets.updatedAt)],
                limit: 10,
                with: { project: { columns: { id: true, name: true } } },
              }),
            [],
          )
        : [],
      modules.timesheets
        ? settle(
            "timesheet",
            () =>
              this.db
                .select({ hours: sum(timesheets.hours) })
                .from(timesheets)
                .where(
                  and(
                    eq(timesheets.orgId, orgId),
                    eq(timesheets.userId, userId),
                    gte(timesheets.date, weekStart.toISOString().slice(0, 10)),
                    lt(timesheets.date, weekEnd.toISOString().slice(0, 10)),
                  ),
                ),
            [],
          )
        : [],
      modules.hr
        ? settle(
            "leaveBalance",
            () =>
              this.db
                .select({
                  id: leaveBalances.id,
                  balance: leaveBalances.balance,
                  total: leaveTypes.daysPerYear,
                  typeName: leaveTypes.name,
                  year: leaveBalances.year,
                })
                .from(leaveBalances)
                .innerJoin(
                  leaveTypes,
                  eq(leaveBalances.leaveTypeId, leaveTypes.id),
                )
                .where(
                  and(
                    eq(leaveBalances.orgId, orgId),
                    eq(leaveBalances.userId, userId),
                    eq(leaveBalances.year, now.getFullYear()),
                  ),
                ),
            [],
          )
        : [],
      settle(
        "upcomingEvents",
        () =>
          this.db
            .select({
              id: calendarEvents.id,
              title: calendarEvents.title,
              startDate: calendarEvents.startDate,
              endDate: calendarEvents.endDate,
              category: calendarEvents.category,
            })
            .from(calendarEvents)
            .where(
              and(
                eq(calendarEvents.orgId, orgId),
                gte(calendarEvents.startDate, now),
              ),
            )
            .orderBy(calendarEvents.startDate)
            .limit(3),
        [],
      ),
      settle(
        "unreadNotifications",
        () =>
          this.db
            .select({ cnt: count() })
            .from(notifications)
            .where(
              and(
                eq(notifications.userId, userId),
                eq(notifications.orgId, orgId),
                eq(notifications.isRead, false),
              ),
            ),
        [],
      ),
    ]);

    const hoursLogged = Number(timesheetRows[0]?.hours ?? 0);
    const weekLabel = `${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

    return {
      myTasks: myTasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueDate: null,
        projectName: t.project?.name ?? null,
      })),
      timesheetStatus: {
        submitted: hoursLogged > 0,
        weekLabel,
        hoursLogged,
      },
      leaveBalance: leaveBalanceRows.map((r) => ({
        type: r.typeName ?? "Leave",
        remaining: Number(r.balance),
        total: r.total ?? 0,
      })),
      upcomingEvents: upcomingEvents.map((e) => ({
        id: e.id,
        title: e.title,
        startTime: e.startDate,
        endTime: e.endDate,
        type: e.category,
      })),
      unreadNotifications: Number(unreadCount[0]?.cnt ?? 0),
      degraded,
    };
  }
}
