import { z } from "zod";

export const providerSyncPayloadSchema = z.object({
  userId: z.string(),
  title: z.string().optional(),
  description: z.string().nullish(),
  startIso: z.string().optional(),
  endIso: z.string().optional(),
  allDay: z.boolean().optional(),
  attendeeEmails: z.array(z.string()).optional(),
  addConference: z.boolean().optional(),
  /**
   * The series' RRULE. Absent from the payload meant absent from the push, and a
   * weekly series reached Google as one meeting at the first occurrence.
   */
  rrule: z.string().nullish(),
  /**
   * Set only on an OCCURRENCE-scoped row: the nominal instant of the single occurrence
   * this job writes, i.e. `calendar_event_exceptions.occurrence_start`. Its presence is
   * what turns an `update`/`delete` into an instance write rather than a series write,
   * so a per-occurrence edit no longer overwrites — or silently skips — the whole series.
   */
  occurrenceStart: z.string().optional(),
});

type ProviderSyncPayload = z.infer<typeof providerSyncPayloadSchema>;

/**
 * The published response contract for `GET|POST /cron/calendar-provider-sync-sweep`.
 *
 * Two arms, because `runCalendarProviderSyncSweep` has two returns: the lease was already
 * held by another worker, or the tick ran and reports its counters. `ResponseContractInterceptor`
 * validates the real handler return against this, so the arms describe the handler's own shape —
 * `build-openapi-document.ts` adds the `{ success, data }` envelope when it publishes.
 */
export const calendarProviderSyncSweepResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    skipped: z.literal(true),
    message: z.string(),
  }),
  z.object({
    success: z.literal(true),
    message: z.string(),
    organizations: z.object({
      organizations: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
    claimed: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    retried: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
]);
