import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  and,
  eq,
  exists,
  gte,
  lt,
  ne,
  or,
  sql,
  sum,
} from "drizzle-orm";
import {
  calendarEvents,
  eventAttendees,
  organizationMembers,
  timesheets,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { NotificationsService } from "../notifications/notifications.service";
import { DashboardLeaveService } from "./dashboard-leave.service";
import { DashboardProjectService } from "./dashboard-project.service";
import { resolvePersonalDashboardModules } from "./dashboard-scope";

const ACTIVE_TICKET_STATUSES = ["TODO", "IN_PROGRESS", "IN_REVIEW"];

@Injectable()
export class DashboardPersonalService {
  private readonly logger = new Logger(DashboardPersonalService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly leaveService: DashboardLeaveService,
    private readonly projectService: DashboardProjectService,
    private readonly notificationsService: NotificationsService,
  ) {}

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
    const selfMember = await this.db.query.organizationMembers.findFirst({ where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)), columns: { id: true } });
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
      unreadNotifResult,
    ] = await Promise.all([
      modules.build
        ? settle(
            "myTasks",
            () => this.projectService.getMyIssues(orgId, userId, ACTIVE_TICKET_STATUSES),
            [],
          )
        : [],
      modules.timesheets
        ? settle(
            "timesheet",
            async () => {
              if (!selfMember) return [];
              return this.db
                .select({ hours: sum(timesheets.hours) })
                .from(timesheets)
                .where(
                  and(
                    eq(timesheets.orgId, orgId),
                    eq(timesheets.userMembershipId, selfMember.id),
                    gte(timesheets.date, weekStart.toISOString().slice(0, 10)),
                    lt(timesheets.date, weekEnd.toISOString().slice(0, 10)),
                  ),
                );
            },
            [],
          )
        : [],
      modules.hr
        ? settle(
            "leaveBalance",
            () => this.leaveService.getMyLeaveBalance(orgId, userId),
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
                or(
                  eq(calendarEvents.visibility, "org"),
                  exists(
                    this.db
                      .select({ one: sql`1` })
                      .from(organizationMembers)
                      .where(
                        and(
                          eq(organizationMembers.orgId, calendarEvents.orgId),
                          eq(organizationMembers.id, calendarEvents.createdByMembershipId),
                          eq(organizationMembers.userId, userId),
                          eq(organizationMembers.status, "ACTIVE"),
                        ),
                      )
                  ),
                  exists(
                    this.db
                      .select({ one: sql`1` })
                      .from(eventAttendees)
                      .innerJoin(
                        organizationMembers,
                        and(
                          eq(eventAttendees.orgId, organizationMembers.orgId),
                          eq(
                            eventAttendees.membershipId,
                            organizationMembers.id,
                          ),
                        ),
                      )
                      .where(
                        and(
                          eq(eventAttendees.orgId, orgId),
                          eq(eventAttendees.eventId, calendarEvents.id),
                          eq(organizationMembers.userId, userId),
                          eq(organizationMembers.status, "ACTIVE"),
                          ne(eventAttendees.status, "declined"),
                        ),
                      ),
                  ),
                ),
              ),
            )
            .orderBy(calendarEvents.startDate)
            .limit(3),
        [],
      ),
      settle(
        "unreadNotifications",
        () => this.notificationsService.unreadCount(orgId, userId),
        { count: 0 },
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
        projectName: t.projectName || null,
      })),
      timesheetStatus: {
        submitted: hoursLogged > 0,
        weekLabel,
        hoursLogged,
      },
      leaveBalance: leaveBalanceRows.map((r) => ({
        type: r.leaveTypeName ?? "Leave",
        remaining: Number(r.balance),
        total: r.daysPerYear ?? 0,
      })),
      upcomingEvents: upcomingEvents.map((e) => ({
        id: e.id,
        title: e.title,
        startTime: e.startDate,
        endTime: e.endDate,
        type: e.category,
      })),
      unreadNotifications: unreadNotifResult.count,
      degraded,
    };
  }
}
