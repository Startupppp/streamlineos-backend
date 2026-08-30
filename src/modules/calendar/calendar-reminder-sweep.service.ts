import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  calendarEventExceptions,
  calendarEvents,
  eventAttendees,
  notificationOutbox,
  organizationMembers,
} from "../../db/schema";
import { forEachOrg } from "../../common/tenant";
import type { ForEachOrgResult } from "../../common/tenant/for-each-org";
import { expandToOccurrences } from "./calendar-occurrence.service";

const REMINDER_WINDOW_MS = 20 * 60 * 1000;
const EVENT_BATCH_LIMIT = 200;

export interface CalendarReminderSweepResult {
  organizations: ForEachOrgResult;
  candidates: number;
  intentsWritten: number;
}

@Injectable()
export class CalendarReminderSweepService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async run(now = new Date()): Promise<CalendarReminderSweepResult> {
    const dueBy = new Date(now.getTime() + REMINDER_WINDOW_MS);
    let candidates = 0;
    let intentsWritten = 0;

    const organizations = await forEachOrg(this.db, "calendar-reminder-sweep", async (tx, orgId) => {
      const nonRecurring = await tx
        .select({ id: calendarEvents.id, title: calendarEvents.title, startDate: calendarEvents.startDate })
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.orgId, orgId),
            eq(calendarEvents.reminder15MinSent, false),
            eq(calendarEvents.allDay, false),
            isNull(calendarEvents.rrule),
            gte(calendarEvents.startDate, now),
            lte(calendarEvents.startDate, dueBy),
          ),
        )
        .limit(EVENT_BATCH_LIMIT);

      const recurring = await tx
        .select({
          id: calendarEvents.id,
          title: calendarEvents.title,
          startDate: calendarEvents.startDate,
          endDate: calendarEvents.endDate,
          allDay: calendarEvents.allDay,
          timezone: calendarEvents.timezone,
          orgId: calendarEvents.orgId,
          rrule: calendarEvents.rrule,
          recurrenceEnd: calendarEvents.recurrenceEnd,
        })
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.orgId, orgId),
            eq(calendarEvents.allDay, false),
            isNotNull(calendarEvents.rrule),
            lte(calendarEvents.startDate, dueBy),
            or(isNull(calendarEvents.recurrenceEnd), gte(calendarEvents.recurrenceEnd, now)),
          ),
        )
        .limit(EVENT_BATCH_LIMIT);

      const recurringIds = recurring.map((e) => e.id);
      const exceptions =
        recurringIds.length === 0
          ? []
          : await tx
              .select({
                eventId: calendarEventExceptions.eventId,
                occurrenceStart: calendarEventExceptions.occurrenceStart,
                isCancelled: calendarEventExceptions.isCancelled,
              })
              .from(calendarEventExceptions)
              .where(
                and(
                  eq(calendarEventExceptions.orgId, orgId),
                  inArray(calendarEventExceptions.eventId, recurringIds),
                  gte(calendarEventExceptions.occurrenceStart, now),
                  lte(calendarEventExceptions.occurrenceStart, dueBy),
                ),
              )
              .limit(EVENT_BATCH_LIMIT * 10);

      const cancelledKeys = new Set(
        exceptions.filter((e) => e.isCancelled).map((e) => `${e.eventId}:${e.occurrenceStart.getTime()}`),
      );

      const recurringOccurrences: Array<{ id: number; title: string; startDate: Date }> = [];
      for (const event of recurring) {
        if (!event.rrule) continue;
        const occurrences = expandToOccurrences(
          {
            id: event.id,
            title: event.title,
            startDate: event.startDate,
            endDate: event.endDate,
            allDay: event.allDay ?? false,
            timezone: event.timezone,
            orgId: event.orgId,
            rrule: event.rrule,
            recurrenceEnd: event.recurrenceEnd,
          },
          now,
          dueBy,
        );
        for (const occ of occurrences) {
          if (cancelledKeys.has(`${event.id}:${occ.startDate.getTime()}`)) continue;
          recurringOccurrences.push({ id: event.id, title: occ.title, startDate: occ.startDate });
        }
      }

      type Candidate = { id: number; title: string; startDate: Date; isRecurring: boolean };
      const allCandidates: Candidate[] = [
        ...nonRecurring.map((e) => ({ ...e, isRecurring: false as const })),
        ...recurringOccurrences.map((e) => ({ ...e, isRecurring: true as const })),
      ];

      candidates += allCandidates.length;
      if (allCandidates.length === 0) return;

      const eventIds = [...new Set(allCandidates.map((e) => e.id))];
      const attendees = await tx
        .select({ eventId: eventAttendees.eventId, userId: organizationMembers.userId })
        .from(eventAttendees)
        .innerJoin(
          organizationMembers,
          and(
            eq(eventAttendees.orgId, organizationMembers.orgId),
            eq(eventAttendees.membershipId, organizationMembers.id),
          ),
        )
        .where(
          and(
            eq(eventAttendees.orgId, orgId),
            eq(organizationMembers.status, "ACTIVE"),
            inArray(eventAttendees.eventId, eventIds),
          ),
        )
        .limit(EVENT_BATCH_LIMIT * 50);

      const recipientsByEvent = new Map<number, string[]>();
      for (const attendee of attendees) {
        const recipients = recipientsByEvent.get(attendee.eventId) ?? [];
        recipients.push(attendee.userId);
        recipientsByEvent.set(attendee.eventId, recipients);
      }

      for (const candidate of allCandidates) {
        const targetUserIds = [...new Set(recipientsByEvent.get(candidate.id) ?? [])];
        const occurrenceIso = candidate.startDate.toISOString();
        const inserted = await tx
          .insert(notificationOutbox)
          .values({
            orgId,
            eventKey: "calendar.reminder",
            dedupeKey: `calendar:reminder:${candidate.id}:${occurrenceIso}`,
            actorUserId: null,
            targetUserIds,
            entityType: "calendar_event",
            entityId: String(candidate.id),
            title: `Upcoming event: ${candidate.title}`,
            message: `"${candidate.title}" starts at ${occurrenceIso}`,
            link: "/calendar",
            variables: { eventTitle: candidate.title, startIso: occurrenceIso },
          })
          .onConflictDoNothing({ target: [notificationOutbox.orgId, notificationOutbox.dedupeKey] })
          .returning({ id: notificationOutbox.id });
        if (inserted.length > 0) intentsWritten += 1;

        if (!candidate.isRecurring)
          await tx
            .update(calendarEvents)
            .set({ reminder15MinSent: true, updatedAt: new Date() })
            .where(and(eq(calendarEvents.orgId, orgId), eq(calendarEvents.id, candidate.id)));
      }
    });

    return { organizations, candidates, intentsWritten };
  }
}
