import { z } from "zod";

const forEachOrgResultSchema = z.object({
  organizations: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

/**
 * The published response contract for `GET|POST /cron/calendar-reminder-sweep`.
 *
 * Two arms, mirroring `runCalendarReminderSweep` in `cron-calendar.controller.ts`:
 * the lease was already held (skip), or the tick ran and reports its counters.
 * `ResponseContractInterceptor` validates the real handler return against this.
 */
export const calendarReminderSweepResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    skipped: z.literal(true),
    message: z.string(),
  }),
  z.object({
    success: z.literal(true),
    organizations: forEachOrgResultSchema,
    candidates: z.number().int().nonnegative(),
    intentsWritten: z.number().int().nonnegative(),
  }),
]);
