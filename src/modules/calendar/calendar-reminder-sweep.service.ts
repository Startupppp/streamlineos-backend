import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  calendarEvents,
  eventAttendees,
  notificationOutbox,
  organizationMembers,
} from "../../db/schema";
import { forEachOrg } from "../../common/tenant";
import type { ForEachOrgResult } from "../../common/tenant/for-each-org";

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
      const events = await tx
        .select({ id: calendarEvents.id, title: calendarEvents.title, startDate: calendarEvents.startDate })
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.orgId, orgId),
            eq(calendarEvents.reminder15MinSent, false),
            eq(calendarEvents.allDay, false),
            gte(calendarEvents.startDate, now),
            lte(calendarEvents.startDate, dueBy),
          ),
        )
        .limit(EVENT_BATCH_LIMIT);
      candidates += events.length;
      if (events.length === 0) return;

      const eventIds = events.map((event) => event.id);
      const attendees = await tx
        .select({ eventId: eventAttendees.eventId, userId: eventAttendees.userId })
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
        );
      const recipientsByEvent = new Map<number, string[]>();
      for (const attendee of attendees) {
        const recipients = recipientsByEvent.get(attendee.eventId) ?? [];
        recipients.push(attendee.userId);
        recipientsByEvent.set(attendee.eventId, recipients);
      }

      for (const event of events) {
        const targetUserIds = [...new Set(recipientsByEvent.get(event.id) ?? [])];
        const inserted = await tx
          .insert(notificationOutbox)
          .values({
            orgId,
            eventKey: "calendar.reminder",
            dedupeKey: `calendar:reminder:${event.id}`,
            actorUserId: null,
            targetUserIds,
            entityType: "calendar_event",
            entityId: String(event.id),
            title: `Upcoming event: ${event.title}`,
            message: `"${event.title}" starts at ${event.startDate.toISOString()}`,
            link: "/calendar",
            variables: { eventTitle: event.title, startIso: event.startDate.toISOString() },
          })
          .onConflictDoNothing({ target: [notificationOutbox.orgId, notificationOutbox.dedupeKey] })
          .returning({ id: notificationOutbox.id });
        if (inserted.length > 0) intentsWritten += 1;
        await tx
          .update(calendarEvents)
          .set({ reminder15MinSent: true, updatedAt: new Date() })
          .where(and(eq(calendarEvents.orgId, orgId), eq(calendarEvents.id, event.id)));
      }
    });

    return { organizations, candidates, intentsWritten };
  }
}
