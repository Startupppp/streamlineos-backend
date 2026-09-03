import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  and,
  eq,
  exists,
  gte,
  isNotNull,
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
import { DashboardProjectService } from "./dashboard-project.service";
import { resolvePersonalDashboardModules } from "./dashboard-scope";
import { settleSection } from "./dashboard-section-settle";

const ACTIVE_TICKET_STATUSES = ["TODO", "IN_PROGRESS", "IN_REVIEW"];

@Injectable()
export class DashboardPersonalService {
  private readonly logger = new Logger(DashboardPersonalService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly projectService: DashboardProjectService,
  ) {}

  async getPersonalDashboard(u: CurrentUserContext) {
    const { orgId, userId } = u;
    const degraded: string[] = [];
    const settle = <T>(source: string, run: () => Promise<T>, fallback: T): Promise<T> =>
      settleSection({
        name: source,
        run,
        fallback,
        logger: this.logger,
        context: `org ${orgId}`,
        onDegraded: (name) => degraded.push(name),
      });

    /**
     * The prologue is deadline-protected too, and it FAILS CLOSED.
     *
     * These two reads gate the entire fanout — nothing below starts until they
     * resolve — and both do real database work: `moduleAvailability` goes
     * through `entitlements.getModuleMap` -> `cache.cachedForOrg` ->
     * `runInTenantTransaction`, and the membership lookup is a direct query.
     * Awaiting them bare put the one thing that gates every section outside the
     * only ceiling the endpoint has, so an entitlements cache stampede on a
     * version bump, or Redis timing out into a slow Postgres, hung `/dashboard/personal`
     * with every section still unstarted. PRD-C144 forbids exactly that, one
     * layer above where the deadline was applied.
     *
     * Fallbacks deny rather than open: a gate that could not be resolved must not
     * be read as "allowed". And the sections the gate governs are reported as
     * degraded, because "we could not find out" has to render as "couldn't load",
     * never as an authoritative empty list.
     */
    const [modules, selfMember] = await Promise.all([
      settle(
        "modules",
        () => resolvePersonalDashboardModules(this.access, u),
        { build: false, timesheets: false, hr: false },
      ).then((resolved) => {
        if (degraded.includes("modules")) degraded.push("myTasks", "timesheet");
        return resolved;
      }),
      settle(
        "membership",
        () =>
          this.db.query.organizationMembers.findFirst({
            where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
            columns: { id: true, status: true },
          }),
        undefined,
      ).then((resolved) => {
        if (degraded.includes("membership")) degraded.push("timesheet", "upcomingEvents");
        return resolved;
      }),
    ]);
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const attendeeMembershipId = selfMember?.status === "ACTIVE" ? selfMember.id : 0;

    /**
     * THREE branches, not five.
     *
     * `unreadNotifications` and `leaveBalance` were computed on every uncached
     * Home load and read by nothing. A grep over the frontend finds
     * `unreadNotifications` exactly once — as a type field at
     * `hooks/api/dashboard.ts` — and the aggregate's `leaveBalance` exactly once,
     * in the same interface; `usePersonalDashboard` has exactly three consumers
     * (`my-tasks-widget`, `timesheet-widget`, `upcoming-events-widget`) and they
     * read `myTasks`, `timesheetStatus` and `upcomingEvents`. The leave balance
     * Home actually renders comes from a different route entirely
     * (`hr-widgets.tsx` -> `useMyLeaveBalance` -> GET /dashboard/my-leave-balance).
     *
     * The unread count was also the most expensive query on the surface —
     * measured on scratch_head_1010 as `streamline_app` with the tenant GUC at
     * 14,053 planning buffers and 14.4 ms of PLANNING against 0.69-1.57 ms of
     * execution, because `notifications` has 49 partitions and `prepare: false`
     * rebuilds the plan every request. It is the branch that forced
     * HOME_SECTION_DEADLINE_MS into existence, so the most timeout-prone source
     * on Home was producing a number nothing rendered.
     *
     * If either is wanted back, wire it to a consumer AND to its `degraded`
     * entry in the same change. `dashboard-home-fanout.spec.ts` pins the branch
     * count so a re-added dead branch is caught.
     */
    const [myTasks, timesheetRows, upcomingEvents] = await Promise.all([
      modules.build
        ? settle(
            "myTasks",
            () => this.projectService.getMyIssues(orgId, userId, ACTIVE_TICKET_STATUSES, selfMember?.id ?? null),
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
      settle(
        "upcomingEvents",
        () => {
          const attendedEvent = this.db
            .select({ hit: sql<number>`1`.as("hit") })
            .from(eventAttendees)
            .where(
              and(
                eq(eventAttendees.orgId, orgId),
                eq(eventAttendees.eventId, calendarEvents.id),
                eq(eventAttendees.membershipId, attendeeMembershipId),
                ne(eventAttendees.status, "declined"),
              ),
            )
            .limit(1)
            .as("attended_event");
          return this.db
            .select({
              id: calendarEvents.id,
              title: calendarEvents.title,
              startDate: calendarEvents.startDate,
              endDate: calendarEvents.endDate,
              category: calendarEvents.category,
            })
            .from(calendarEvents)
            .leftJoinLateral(attendedEvent, sql`true`)
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
                  isNotNull(attendedEvent.hit),
                ),
              ),
            )
            .orderBy(calendarEvents.startDate)
            .limit(3);
        },
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
        projectName: t.projectName || null,
      })),
      timesheetStatus: {
        submitted: hoursLogged > 0,
        weekLabel,
        hoursLogged,
      },
      upcomingEvents: upcomingEvents.map((e) => ({
        id: e.id,
        title: e.title,
        startTime: e.startDate,
        endTime: e.endDate,
        type: e.category,
      })),
      // Deduped: a degraded prologue names the sections it gates, and one of
      // those can also fail on its own.
      degraded: [...new Set(degraded)],
    };
  }
}
