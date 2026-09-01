import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  exists,
  gte,
  isNull,
  lt,
  ne,
  or,
  sql,
  sum,
} from "drizzle-orm";
import {
  calendarEvents,
  eventAttendees,
  leaveBalances,
  leaveTypes,
  notifications,
  organizationMembers,
  tickets,
  timesheets,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { resolvePersonalDashboardModules } from "./dashboard-scope";

@Injectable()
export class DashboardPersonalService {
  private readonly logger = new Logger(DashboardPersonalService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
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
            async () => {
              const [selfMember] = await this.db
                .select({ id: organizationMembers.id })
                .from(organizationMembers)
                .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
                .limit(1);
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
