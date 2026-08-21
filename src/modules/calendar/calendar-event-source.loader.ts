import {
  and,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
} from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import {
  attendance,
  calendarEvents,
  eventAttendees,
  interviewPanelMembers,
  interviews,
  leaveRequests,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  rosterEntries,
  rosters,
  tasks,
  tickets,
  users,
  wfhRequests,
} from "../../db/schema";
import { listCompatibleHolidays } from "../../db/compat/organization-holidays";
import { AttendancePolicyService } from "../hr/time/attendance-policy.service";
import type { LinkedTicket } from "./calendar.types";
import { dateOnly } from "./calendar.types";

export class CalendarEventSourceLoader {
  constructor(
    private readonly database: Db,
    private readonly attendancePolicy: AttendancePolicyService,
  ) {}

  async load(orgId: string, userId: string, start: Date, end: Date) {
    const policyDate = dateOnly(end.getTime() < Date.now() ? end : new Date());
    const [
      eventsData,
      leavesData,
      interviewsData,
      tasksData,
      holidaysData,
      projectTicketsData,
      attendanceData,
      wfhData,
      organizationData,
      rosterDatesData,
      attendanceRules,
      shiftRosterRules,
      membershipData,
    ] =
      await Promise.all([
        this.database.query.calendarEvents.findMany({
          where: and(
            eq(calendarEvents.orgId, orgId),
            gte(calendarEvents.startDate, start),
            lte(calendarEvents.startDate, end),
          ),
          with: { creator: { columns: { name: true } } },
          orderBy: (t, { asc }) => [asc(t.startDate)],
        }),

        this.database
          .select({
            id: leaveRequests.id,
            userId: leaveRequests.userId,
            startDate: leaveRequests.startDate,
            endDate: leaveRequests.endDate,
            reason: leaveRequests.reason,
            userName: users.name,
            isHalfDay: leaveRequests.isHalfDay,
            halfDayPeriod: leaveRequests.halfDayPeriod,
          })
          .from(leaveRequests)
          .innerJoin(users, eq(leaveRequests.userId, users.id))
          .where(
            and(
              eq(leaveRequests.orgId, orgId),
              eq(leaveRequests.status, "APPROVED"),
              lte(leaveRequests.startDate, dateOnly(end)),
              gte(leaveRequests.endDate, dateOnly(start)),
            ),
          ),

        this.database
          .select({
            id: interviews.id,
            scheduledAt: interviews.scheduledAt,
            duration: interviews.duration,
            type: interviews.type,
            interviewerId: interviews.interviewerId,
            location: interviews.location,
            meetingLink: interviews.meetingLink,
          })
          .from(interviews)
          .where(
            and(
              eq(interviews.orgId, orgId),
              gte(interviews.scheduledAt, start),
              lte(interviews.scheduledAt, end),
              or(
                eq(interviews.interviewerId, userId),
                exists(
                  this.database
                    .select({ id: interviewPanelMembers.id })
                    .from(interviewPanelMembers)
                    .where(
                      and(
                        eq(interviewPanelMembers.orgId, orgId),
                        eq(interviewPanelMembers.interviewId, interviews.id),
                        eq(interviewPanelMembers.userId, userId),
                      ),
                    ),
                ),
              ),
            ),
          ),

        this.database
          .select({
            id: tasks.id,
            title: tasks.title,
            dueDate: tasks.dueDate,
            status: tasks.status,
            assigneeId: tasks.assigneeId,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.orgId, orgId),
              eq(tasks.assigneeId, userId),
              isNotNull(tasks.dueDate),
              gte(tasks.dueDate, start),
              lte(tasks.dueDate, end),
            ),
          ),

        listCompatibleHolidays(this.database, orgId, dateOnly(start), dateOnly(end)),

        this.database
          .select({
            id: tickets.id,
            title: tickets.title,
            dueDate: tickets.dueDate,
            status: tickets.status,
            ticketNumber: tickets.ticketNumber,
            projectId: projects.id,
            projectKey: projects.key,
          })
          .from(tickets)
          .innerJoin(projects, eq(tickets.projectId, projects.id))
          .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
          .where(
            and(
              eq(tickets.orgId, orgId),
              eq(projectMembers.userId, userId),
              isNotNull(tickets.dueDate),
              gte(tickets.dueDate, dateOnly(start)),
              lte(tickets.dueDate, dateOnly(end)),
            ),
          ),

        this.database
          .select({
            id: attendance.id,
            date: attendance.date,
            checkIn: attendance.checkIn,
            checkOut: attendance.checkOut,
            status: attendance.status,
            workHours: attendance.workHours,
            breakHours: attendance.breakHours,
            createdAt: attendance.createdAt,
          })
          .from(attendance)
          .where(
            and(
              eq(attendance.orgId, orgId),
              eq(attendance.userId, userId),
              gte(attendance.date, dateOnly(start)),
              lte(attendance.date, dateOnly(end)),
            ),
          )
          .orderBy(desc(attendance.createdAt)),

        this.database
          .select({ id: wfhRequests.id, date: wfhRequests.date })
          .from(wfhRequests)
          .where(
            and(
              eq(wfhRequests.orgId, orgId),
              eq(wfhRequests.userId, userId),
              eq(wfhRequests.status, "APPROVED"),
              gte(wfhRequests.date, dateOnly(start)),
              lte(wfhRequests.date, dateOnly(end)),
            ),
          ),

        this.database
          .select({ timezone: organizations.timezone })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1),

        this.database
          .select({ date: rosterEntries.date })
          .from(rosterEntries)
          .innerJoin(
            rosters,
            and(eq(rosters.id, rosterEntries.rosterId), eq(rosters.orgId, orgId)),
          )
          .where(
            and(
              eq(rosterEntries.userId, userId),
              gte(rosterEntries.date, dateOnly(start)),
              lte(rosterEntries.date, dateOnly(end)),
            ),
          ),

        this.attendancePolicy.getAttendanceRules(orgId, userId, policyDate),
        this.attendancePolicy.getShiftRosterRules(orgId, userId, policyDate),
        this.database
          .select({
            joinedAt: organizationMembers.joinedAt,
            activatedAt: organizationMembers.activatedAt,
            joiningDate: users.joiningDate,
          })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(
            and(
              eq(organizationMembers.orgId, orgId),
              eq(organizationMembers.userId, userId),
            ),
          )
          .limit(1),
      ]);

    const eventIds = eventsData.map((eventRecord) => eventRecord.id);
    const ticketEntityIds: number[] = [];
    for (const eventRecord of eventsData) {
      if (eventRecord.entityType === "ticket" && eventRecord.entityId != null) {
        const linkedTicketIdentifier = parseInt(eventRecord.entityId, 10);
        if (!Number.isNaN(linkedTicketIdentifier)) ticketEntityIds.push(linkedTicketIdentifier);
      }
    }

    const rsvpMap = new Map<number, string>();
    const linkedTicketMap = new Map<number, LinkedTicket>();

    await Promise.all([
      (async () => {
        if (eventIds.length === 0) return;
        const rows = await this.database
          .select({ eventId: eventAttendees.eventId, status: eventAttendees.status })
          .from(eventAttendees)
          .where(
            and(eq(eventAttendees.userId, userId), inArray(eventAttendees.eventId, eventIds)),
          );
        for (const row of rows) {
          rsvpMap.set(row.eventId, row.status ?? "pending");
        }
      })(),
      (async () => {
        if (ticketEntityIds.length === 0) return;
        const rows = await this.database
          .select({
            id: tickets.id,
            ticketNumber: tickets.ticketNumber,
            title: tickets.title,
            projectId: projects.id,
            status: tickets.status,
            projectKey: projects.key,
          })
          .from(tickets)
          .innerJoin(projects, eq(tickets.projectId, projects.id))
          .where(and(eq(tickets.orgId, orgId), inArray(tickets.id, ticketEntityIds)));
        for (const row of rows) {
          linkedTicketMap.set(row.id, {
            id: row.id,
            key: `${row.projectKey}-${row.ticketNumber}`,
            title: row.title,
            projectId: row.projectId,
            status: row.status,
          });
        }
      })(),
    ]);
    return {
      eventsData,
      leavesData,
      interviewsData,
      tasksData,
      holidaysData,
      projectTicketsData,
      attendanceData,
      wfhData,
      organizationData,
      rosterDatesData,
      attendanceRules,
      shiftRosterRules,
      membershipData,
      rsvpMap,
      linkedTicketMap,
    };
  }
}
