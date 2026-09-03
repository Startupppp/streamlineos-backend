import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

/**
 * The response half of the calendar contract.
 *
 * Every schema here is derived from the SERVICE PROJECTION and the Drizzle column it
 * reads, never from the browser client's hand-written interface — a contract copied
 * from the consumer's type encodes the drift instead of catching it. The file:line of
 * the projection each one describes is named above it, so the next reader can check
 * the derivation rather than trusting it.
 *
 * `ResponseContractInterceptor` compares these against what the handler actually
 * returned on every request under `NODE_ENV=test`, so a schema written wrong here
 * fails the suite rather than becoming documentation nobody compared.
 *
 * NOT `.strict()`, matching the browser client's own policy
 * (`frontend/lib/api-envelope.ts`): an ADDED response field is a backward-compatible
 * deploy and must not fail a running client, while a removed, renamed or retyped one
 * is the drift these exist to catch — and a plain object already rejects all three.
 * The asymmetry with REQUEST schemas, which ARE `.strict()`, is deliberate: an
 * undeclared field arriving in a request body is an attacker or a bug, while an
 * undeclared field leaving in a response is a deploy in progress.
 */

/** `CalendarEventItem` — `calendar-events-aggregate.service.ts` `projectionToItem`. */
export const calendarEventItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  start: wireDate(),
  end: wireDate(),
  allDay: z.boolean().optional(),
  color: z.string().nullable().optional(),
  category: z.string(),
  source: z.enum(["event", "leave", "interview", "task", "holiday", "attendance"]),
  timezone: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  meetingUrl: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  creatorName: z.string().nullable().optional(),
  entityId: z.string().nullable().optional(),
  entityType: z.string().nullable().optional(),
  myRsvpStatus: z.string().nullable().optional(),
  projectId: z.number().int().nullable().optional(),
  linkedTicket: z
    .object({
      id: z.number().int(),
      key: z.string(),
      title: z.string(),
      projectId: z.number().int(),
      status: z.string(),
    })
    .nullable()
    .optional(),
  rrule: z.string().nullable().optional(),
  isRecurring: z.boolean().optional(),
});

/** `CalendarEventsResult` — `CalendarEventsAggregateService.getEvents`. */
export const calendarEventsResponseSchema = z.object({
  events: z.array(calendarEventItemSchema),
  failures: z.array(z.object({ key: z.string(), label: z.string() })),
  truncated: z.boolean(),
});

/**
 * `ExternalEventsResult` — `ExternalCalendarEventsService.getExternalEvents`.
 * `start`/`end` are STRINGS here and `Date`s on the native item: the external
 * normalizers (`external-event-normalizers.ts:30-31`) carry the provider's own ISO
 * string through untouched. Two shapes for the same concept on two routes is itself
 * worth knowing, and writing the contract is what made it visible.
 */
export const externalCalendarEventsResponseSchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      connectionId: z.number().int(),
      toolkit: z.enum(["googlecalendar", "outlook"]),
      accountEmail: z.string().nullable(),
      providerEventId: z.string(),
      title: z.string(),
      start: z.string(),
      end: z.string(),
      allDay: z.boolean(),
      location: z.string().nullable(),
      meetingUrl: z.string().nullable(),
      webLink: z.string().nullable(),
    }),
  ),
  errors: z.array(
    z.object({
      connectionId: z.number().int(),
      accountEmail: z.string().nullable(),
      message: z.string(),
    }),
  ),
});

/** `ToggleEntry[]` — `CalendarSourceRegistry.getToggleList`. */
export const calendarSourcesResponseSchema = z.array(
  z.object({
    key: z.string(),
    label: z.string(),
    module: z.string(),
    enabled: z.boolean(),
  }),
);

/** `CalendarController.setSourcePreference` returns its own two inputs back. */
export const calendarSourcePreferenceResponseSchema = z.object({
  sourceKey: z.string(),
  enabled: z.boolean(),
});

/** `CalendarAttendeesService.listAttendees` — the explicit five-column projection. */
export const calendarAttendeeListResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    status: z.string(),
    user: z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string(),
      image: z.string().nullable(),
    }),
  }),
);

/**
 * `CalendarAttendeesService.rsvp` returns the inserted `event_attendees` row via a
 * bare `.returning()`, so the contract is that table's whole column list. Recorded as
 * it is rather than as it ought to be — narrowing it to `{ id, status }` is a wire
 * change and belongs to the ticket that also updates the client, not to the contract
 * that documents today's response. PRD-C088 residue, named in report 04.
 */
export const calendarRsvpResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  eventId: z.number().int(),
  membershipId: z.number().int(),
  status: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `CalendarService.deleteEvent`. */
export const calendarDeleteEventResponseSchema = z.object({ deleted: z.boolean() });
