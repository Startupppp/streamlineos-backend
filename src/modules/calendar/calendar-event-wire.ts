import { calendarEvents } from "../../db/schema";

/**
 * The wire shape of a mutated calendar event — PRD-C086/C088.
 *
 * `createEvent` and `updateEvent` both used a bare `.returning()`, which is every one
 * of the 26 columns on `calendar_events`. Nine of them are not the caller's business:
 * `createdByMembershipId` and `reminder15MinSent` are internal bookkeeping,
 * `integrationConnectionId` and `externalEventId` name a provider connection the
 * caller never sees, and `agenda`, `postMeetingNotes`, `visibility`, `linkedDealId`
 * and `linkedLeadId` are other domains riding along on a calendar response. The
 * browser client declared none of them, so every one was bytes on the wire with no
 * reader — and two of them leaked integration internals to any attendee.
 *
 * This is the projection the client actually consumes (`frontend/hooks/api/calendar.ts`
 * `CalendarEvent`), plus `localVersion`, which is the event's concurrency token and the
 * one internal field a caller has a use for.
 */
export const calendarEventWireColumns = {
  id: calendarEvents.id,
  orgId: calendarEvents.orgId,
  title: calendarEvents.title,
  description: calendarEvents.description,
  location: calendarEvents.location,
  meetingUrl: calendarEvents.meetingUrl,
  startDate: calendarEvents.startDate,
  endDate: calendarEvents.endDate,
  timezone: calendarEvents.timezone,
  allDay: calendarEvents.allDay,
  color: calendarEvents.color,
  category: calendarEvents.category,
  entityType: calendarEvents.entityType,
  entityId: calendarEvents.entityId,
  rrule: calendarEvents.rrule,
  recurrenceEnd: calendarEvents.recurrenceEnd,
  localVersion: calendarEvents.localVersion,
  createdAt: calendarEvents.createdAt,
  updatedAt: calendarEvents.updatedAt,
};

/**
 * `updateEvent` needs the two provider-sync columns to decide whether to enqueue a
 * push, and must not put them on the wire. Reading them here and dropping them in
 * `toWireEvent` keeps the decision on one row read instead of a second SELECT.
 */
export const calendarEventUpdateReturning = {
  ...calendarEventWireColumns,
  integrationConnectionId: calendarEvents.integrationConnectionId,
  externalEventId: calendarEvents.externalEventId,
};

export type CalendarEventUpdateRow = Pick<
  typeof calendarEvents.$inferSelect,
  keyof typeof calendarEventUpdateReturning
>;

export function toWireEvent(row: CalendarEventUpdateRow) {
  return {
    id: row.id,
    orgId: row.orgId,
    title: row.title,
    description: row.description,
    location: row.location,
    meetingUrl: row.meetingUrl,
    startDate: row.startDate,
    endDate: row.endDate,
    timezone: row.timezone,
    allDay: row.allDay,
    color: row.color,
    category: row.category,
    entityType: row.entityType,
    entityId: row.entityId,
    rrule: row.rrule,
    recurrenceEnd: row.recurrenceEnd,
    localVersion: row.localVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
