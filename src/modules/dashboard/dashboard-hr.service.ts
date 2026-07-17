import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, lt, or, sql, sum } from "drizzle-orm";
import {
  attendance,
  calendarEvents,
  expenses,
  leaveBalances,
  leaveRequests,
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
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { getTodayString } from "./date.helpers";

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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getDashboardStats(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.dashboardStats(orgId),
      async () => {
        const today = getTodayString();
        const [org, memberCountResult, projectCountResult, attendanceCountResult] =
          await Promise.all([
            this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId) }),
            this.db
              .select({ count: count() })
              .from(organizationMembers)
              .innerJoin(users, eq(organizationMembers.userId, users.id))
              .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true))),
            this.db.select({ count: count() }).from(projects).where(eq(projects.orgId, orgId)),
            this.db
              .select({ count: count() })
              .from(attendance)
              .where(and(eq(attendance.orgId, orgId), eq(attendance.date, today))),
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
  }

  getTeamAvailability(orgId: string) {
    return this.cache.cached(
      `dashboard:team-availability:${orgId}`,
      async () => {
        const today = getTodayString();
        const todayAttendance = await this.db
          .select({
            userId: attendance.userId,
            checkIn: attendance.checkIn,
            checkOut: attendance.checkOut,
            userName: users.name,
            firstName: users.firstName,
            lastName: users.lastName,
            userImage: users.image,
          })
          .from(attendance)
          .innerJoin(users, eq(attendance.userId, users.id))
          .where(and(eq(attendance.orgId, orgId), eq(attendance.date, today)));

        return todayAttendance.map((record) => ({
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

  getRoleStats(orgId: string): Promise<Record<string, number>> {
    return this.cache.cached(
      `dashboard:role-stats:${orgId}`,
      async () => {
        const rows = await this.db
          .select({ role: users.role, cnt: sql<number>`count(*)::int` })
          .from(organizationMembers)
          .innerJoin(users, eq(organizationMembers.userId, users.id))
          .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
          .groupBy(users.role);
        return Object.fromEntries(rows.map((r) => [r.role, r.cnt]));
      },
      CACHE_TTL.MEDIUM,
    );
  }

  getTeamAttendance(orgId: string) {
    const today = getTodayString();
    return this.cache.cached(
      `dashboard:team-attendance:${orgId}:${today}`,
      () => this.buildTeamAttendance(orgId, today),
      CACHE_TTL.SHORT,
    );
  }

  private async buildTeamAttendance(orgId: string, today: string) {
    const [totalMembersResult, todayAttendance] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true))),
      this.db
        .select({
          userId: attendance.userId,
          userName: users.name,
          userImage: users.image,
          userDesignation: users.designation,
          checkIn: attendance.checkIn,
          checkOut: attendance.checkOut,
          status: attendance.status,
        })
        .from(attendance)
        .innerJoin(users, eq(attendance.userId, users.id))
        .where(and(eq(attendance.orgId, orgId), eq(attendance.date, today))),
    ]);

    const clockedIn = todayAttendance.filter((a) => a.checkIn && !a.checkOut).length;
    const total = totalMembersResult[0]?.count ?? 0;

    return {
      total,
      present: todayAttendance.length,
      clockedIn,
      absent: total - todayAttendance.length,
      records: todayAttendance,
    };
  }

  getBirthdays(orgId: string): Promise<BirthdayEntry[]> {
    const key = `dashboard:birthdays:${orgId}:${new Date().toISOString().slice(0, 10)}`;
    return this.cache.cached(key, () => this.buildBirthdays(orgId), CACHE_TTL.MEDIUM);
  }

  private async buildBirthdays(orgId: string): Promise<BirthdayEntry[]> {
    const today = new Date();
    const windowDates = Array.from({ length: 8 }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      return { str: d.toISOString().split("T")[0], mmdd: `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` };
    });
    const mmddList = windowDates.map((w) => w.mmdd);
    const mmddByDate = new Map(windowDates.map((w) => [w.mmdd, w.str]));

    const mmddValues = sql.join(mmddList.map((d) => sql`${d}`), sql`, `);

    const [bdayMembers, annivMembers] = await Promise.all([
      this.db
        .select({
          id: users.id,
          name: users.name,
          designation: users.designation,
          image: users.image,
          mmdd: sql<string>`to_char(${users.dateOfBirth}::date, 'MM-DD')`,
        })
        .from(users)
        .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
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
          designation: users.designation,
          image: users.image,
          joiningDate: users.joiningDate,
          mmdd: sql<string>`to_char(${users.joiningDate}::date, 'MM-DD')`,
        })
        .from(users)
        .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(users.isActive, true),
            sql`to_char(${users.joiningDate}::date, 'MM-DD') IN (${mmddValues})`,
            sql`EXTRACT(YEAR FROM age(${users.joiningDate}::date)) >= 1`,
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
      result.push({ id: m.id, name: m.name, designation: m.designation, image: m.image, type: "birthday", date: mmddByDate.get(m.mmdd) ?? today.toISOString().split("T")[0] });
    }

    for (const m of annivMembers) {
      const key = `${m.id}-anniversary`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dateStr = mmddByDate.get(m.mmdd) ?? today.toISOString().split("T")[0];
      const years = m.joiningDate ? new Date(dateStr).getFullYear() - new Date(m.joiningDate).getFullYear() : 0;
      result.push({ id: m.id, name: m.name, designation: m.designation, image: m.image, type: "anniversary", date: dateStr, yearsCompleted: years });
    }

    return result.slice(0, 20);
  }

  async getPersonalDashboard(orgId: string, userId: string) {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const [myTasks, timesheetRows, leaveBalanceRows, upcomingEvents, unreadCount] =
      await Promise.all([
        this.db.query.tickets.findMany({
          where: and(
            eq(tickets.orgId, orgId),
            eq(tickets.assigneeId, userId),
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
        this.db
          .select({
            id: leaveBalances.id,
            balance: leaveBalances.balance,
            total: leaveTypes.daysPerYear,
            typeName: leaveTypes.name,
            year: leaveBalances.year,
          })
          .from(leaveBalances)
          .innerJoin(leaveTypes, eq(leaveBalances.leaveTypeId, leaveTypes.id))
          .where(
            and(
              eq(leaveBalances.orgId, orgId),
              eq(leaveBalances.userId, userId),
              eq(leaveBalances.year, now.getFullYear()),
            ),
          ),
        this.db
          .select({
            id: calendarEvents.id,
            title: calendarEvents.title,
            startDate: calendarEvents.startDate,
            endDate: calendarEvents.endDate,
            category: calendarEvents.category,
          })
          .from(calendarEvents)
          .where(and(eq(calendarEvents.orgId, orgId), gte(calendarEvents.startDate, now)))
          .orderBy(calendarEvents.startDate)
          .limit(3),
        this.db
          .select({ cnt: count() })
          .from(notifications)
          .where(and(eq(notifications.userId, userId), eq(notifications.orgId, orgId), eq(notifications.isRead, false))),
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
    };
  }

  async getManagerDashboard(orgId: string, _userId: string) {
    const today = getTodayString();

    const [teamMembers, pendingLeaves, pendingExpenses, overdueTickets] = await Promise.all([
      this.db
        .select({
          userId: users.id,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          checkIn: attendance.checkIn,
          status: attendance.status,
          leaveStatus: leaveRequests.status,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(attendance, and(eq(attendance.userId, users.id), eq(attendance.date, today)))
        .leftJoin(
          leaveRequests,
          and(
            eq(leaveRequests.userId, users.id),
            eq(leaveRequests.status, "APPROVED"),
            lt(leaveRequests.startDate, today),
            gte(leaveRequests.endDate, today),
          ),
        )
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .limit(50),
      this.db
        .select({ cnt: count() })
        .from(leaveRequests)
        .where(and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, "PENDING"))),
      this.db
        .select({ cnt: count() })
        .from(expenses)
        .where(and(eq(expenses.orgId, orgId), eq(expenses.status, "PENDING"))),
      this.db
        .select({ cnt: count() })
        .from(tickets)
        .where(
          and(
            eq(tickets.orgId, orgId),
            or(eq(tickets.status, "TODO"), eq(tickets.status, "IN_PROGRESS")),
          ),
        ),
    ]);

    const teamAttendanceToday = teamMembers.map((m) => {
      let status: "present" | "absent" | "leave" = "absent";
      if (m.leaveStatus === "APPROVED") status = "leave";
      else if (m.checkIn) status = "present";
      return {
        userId: m.userId,
        name:
          m.firstName && m.lastName
            ? `${m.firstName} ${m.lastName}`
            : (m.name ?? "Unknown"),
        status,
      };
    });

    return {
      teamAttendanceToday,
      pendingLeaveApprovals: Number(pendingLeaves[0]?.cnt ?? 0),
      pendingExpenseApprovals: Number(pendingExpenses[0]?.cnt ?? 0),
      teamOverdueTasks: Number(overdueTickets[0]?.cnt ?? 0),
    };
  }
}
