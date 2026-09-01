import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { aliasedTable, and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  calendarEvents,
  eventAttendees,
  interviewBookingLinks,
  interviewPanelMembers,
  interviewScorecards,
  interviews,
  users,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { endOfDay, startOfDay, subDays } from "../../../common/date";

const creatorMember = aliasedTable(organizationMembers, "interviewer_creator_member");

export interface BusyBlock {
  start: string;
  end: string;
  title: string;
}

interface PerformanceAccumulator {
  interviewerId: string;
  interviewerName: string | null;
  interviewerEmail: string | null;
  totalAssigned: number;
  submitted: number;
  totalHoursToSubmit: number;
  recommendations: Record<string, number>;
}

@Injectable()
export class HrInterviewersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async availability(
    orgId: string,
    dateParam: string | undefined,
    idsParam: string | undefined,
  ) {
    if (!dateParam || !idsParam) {
      throw new BadRequestException("date and interviewerIds are required.");
    }

    const date = new Date(dateParam);
    if (Number.isNaN(date.getTime()))
      throw new BadRequestException("Invalid date.");

    const interviewerIds = idsParam.split(",").filter(Boolean);
    if (interviewerIds.length === 0) {
      throw new BadRequestException("At least one interviewer ID required.");
    }

    const dayStart = startOfDay(date);
    const dayEnd = endOfDay(date);

    const events = await this.db
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        startDate: calendarEvents.startDate,
        endDate: calendarEvents.endDate,
        allDay: calendarEvents.allDay,
        createdByUserId: creatorMember.userId,
      })
      .from(calendarEvents)
      .innerJoin(
        creatorMember,
        and(
          eq(creatorMember.orgId, calendarEvents.orgId),
          eq(creatorMember.id, calendarEvents.createdByMembershipId),
        ),
      )
      .where(
        and(
          eq(calendarEvents.orgId, orgId),
          lte(calendarEvents.startDate, dayEnd),
          gte(calendarEvents.endDate, dayStart),
        ),
      )
      .limit(10_000);

    const attendeeRows =
      events.length === 0
        ? []
        : await this.db
            .select({
              eventId: eventAttendees.eventId,
              userId: organizationMembers.userId,
            })
            .from(eventAttendees)
            .innerJoin(
              organizationMembers,
              eq(eventAttendees.membershipId, organizationMembers.id),
            )
            .where(
              and(
                eq(eventAttendees.orgId, orgId),
                eq(organizationMembers.orgId, orgId),
                inArray(
                  eventAttendees.eventId,
                  events.map((event) => event.id),
                ),
              ),
            )
            .limit(10_000);
    const attendeesByEvent = new Map<number, string[]>();
    for (const attendee of attendeeRows) {
      const ids = attendeesByEvent.get(attendee.eventId) ?? [];
      ids.push(attendee.userId);
      attendeesByEvent.set(attendee.eventId, ids);
    }

    const interviewRows = await this.db
      .select({
        id: interviews.id,
        scheduledAt: interviews.scheduledAt,
        duration: interviews.duration,
        interviewerId: interviews.interviewerId,
      })
      .from(interviews)
      .where(
        and(
          eq(interviews.orgId, orgId),
          gte(interviews.scheduledAt, dayStart),
          lte(interviews.scheduledAt, dayEnd),
        ),
      )
      .limit(10_000);

    const busyMap = new Map<string, BusyBlock[]>();
    for (const id of interviewerIds) {
      busyMap.set(id, []);
    }

    for (const ev of events) {
      const eventAttendeeIds = attendeesByEvent.get(ev.id) ?? [];
      const relevantIds = interviewerIds.filter(
        (id) => id === ev.createdByUserId || eventAttendeeIds.includes(id),
      );
      for (const uid of relevantIds) {
        busyMap.get(uid)?.push({
          start: ev.startDate.toISOString(),
          end: ev.endDate.toISOString(),
          title: ev.allDay ? `${ev.title} (all day)` : ev.title,
        });
      }
    }

    for (const iv of interviewRows) {
      if (iv.interviewerId && interviewerIds.includes(iv.interviewerId)) {
        const endTime = new Date(
          iv.scheduledAt.getTime() + (iv.duration ?? 60) * 60_000,
        );
        busyMap.get(iv.interviewerId)?.push({
          start: iv.scheduledAt.toISOString(),
          end: endTime.toISOString(),
          title: "Interview",
        });
      }
    }

    const panelMemberRows = await this.db
      .select({
        scheduledAt: interviews.scheduledAt,
        duration: interviews.duration,
        userId: interviewPanelMembers.userId,
      })
      .from(interviewPanelMembers)
      .innerJoin(
        interviews,
        eq(interviewPanelMembers.interviewId, interviews.id),
      )
      .where(
        and(
          eq(interviews.orgId, orgId),
          gte(interviews.scheduledAt, dayStart),
          lte(interviews.scheduledAt, dayEnd),
          inArray(interviewPanelMembers.userId, interviewerIds),
        ),
      )
      .limit(10_000);

    for (const pm of panelMemberRows) {
      if (busyMap.has(pm.userId)) {
        const endTime = new Date(
          pm.scheduledAt.getTime() + (pm.duration ?? 60) * 60_000,
        );
        busyMap.get(pm.userId)?.push({
          start: pm.scheduledAt.toISOString(),
          end: endTime.toISOString(),
          title: "Interview (Panel)",
        });
      }
    }

    const availability = interviewerIds.map((id) => ({
      interviewerId: id,
      busyBlocks: busyMap.get(id) ?? [],
    }));

    return { date: dateParam, availability };
  }

  async interviewerPerformance(orgId: string, days: number) {
    const since = subDays(new Date(), days);

    const rows = await this.db
      .select({
        interviewerId: interviewScorecards.interviewerId,
        interviewerName: users.name,
        interviewerEmail: users.email,
        scorecardSubmittedAt: interviewScorecards.submittedAt,
        interviewScheduledAt: interviews.scheduledAt,
        recommendation: interviewScorecards.recommendation,
      })
      .from(interviewScorecards)
      .innerJoin(interviews, eq(interviewScorecards.interviewId, interviews.id))
      .innerJoin(users, eq(interviewScorecards.interviewerId, users.id))
      .where(
        and(
          eq(interviews.orgId, orgId),
          isNotNull(interviewScorecards.submittedAt),
          gte(interviews.scheduledAt, since),
        ),
      )
      .limit(10_000);

    const map = new Map<string, PerformanceAccumulator>();

    for (const row of rows) {
      const existing = map.get(row.interviewerId);
      const hoursToSubmit =
        row.scorecardSubmittedAt && row.interviewScheduledAt
          ? (new Date(row.scorecardSubmittedAt).getTime() -
              new Date(row.interviewScheduledAt).getTime()) /
            (1000 * 60 * 60)
          : null;

      if (!existing) {
        map.set(row.interviewerId, {
          interviewerId: row.interviewerId,
          interviewerName: row.interviewerName,
          interviewerEmail: row.interviewerEmail,
          totalAssigned: 1,
          submitted: 1,
          totalHoursToSubmit:
            hoursToSubmit != null && hoursToSubmit >= 0 ? hoursToSubmit : 0,
          recommendations: { [row.recommendation]: 1 },
        });
      } else {
        existing.totalAssigned += 1;
        existing.submitted += 1;
        if (hoursToSubmit != null && hoursToSubmit >= 0) {
          existing.totalHoursToSubmit += hoursToSubmit;
        }
        existing.recommendations[row.recommendation] =
          (existing.recommendations[row.recommendation] ?? 0) + 1;
      }
    }

    const assignedRows = await this.db
      .select({
        interviewerId: interviews.interviewerId,
        count: sql<number>`count(*)::int`,
      })
      .from(interviews)
      .where(
        and(
          eq(interviews.orgId, orgId),
          isNotNull(interviews.interviewerId),
          gte(interviews.scheduledAt, since),
        ),
      )
      .groupBy(interviews.interviewerId);

    const assignedMap = new Map<string, number>();
    for (const r of assignedRows) {
      if (r.interviewerId) assignedMap.set(r.interviewerId, r.count);
    }

    const stats = Array.from(map.values()).map((item) => ({
      interviewerId: item.interviewerId,
      interviewerName: item.interviewerName,
      interviewerEmail: item.interviewerEmail,
      totalAssigned: assignedMap.get(item.interviewerId) ?? item.totalAssigned,
      submitted: item.submitted,
      pending: Math.max(
        0,
        (assignedMap.get(item.interviewerId) ?? item.totalAssigned) -
          item.submitted,
      ),
      avgHoursToSubmit:
        item.submitted > 0
          ? Math.round((item.totalHoursToSubmit / item.submitted) * 10) / 10
          : null,
      recommendations: item.recommendations,
    }));

    stats.sort((a, b) => {
      if (a.avgHoursToSubmit === null && b.avgHoursToSubmit === null) return 0;
      if (a.avgHoursToSubmit === null) return 1;
      if (b.avgHoursToSubmit === null) return -1;
      return a.avgHoursToSubmit - b.avgHoursToSubmit;
    });

    return { stats, period: { days, since: since.toISOString() } };
  }

  listBookingLinks(orgId: string) {
    return this.db.query.interviewBookingLinks.findMany({
      where: eq(interviewBookingLinks.orgId, orgId),
      orderBy: [desc(interviewBookingLinks.createdAt)],
      limit: 100,
      with: {
        candidate: {
          columns: { id: true, firstName: true, lastName: true, email: true },
        },
        jobPosting: { columns: { id: true, title: true } },
        creator: { columns: { id: true, name: true } },
      },
    });
  }

  async cancelBookingLink(orgId: string, linkId: number) {
    const existing = await this.db.query.interviewBookingLinks.findFirst({
      where: and(
        eq(interviewBookingLinks.id, linkId),
        eq(interviewBookingLinks.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) return null;

    await this.db
      .update(interviewBookingLinks)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(interviewBookingLinks.id, linkId));

    return { success: true };
  }
}
