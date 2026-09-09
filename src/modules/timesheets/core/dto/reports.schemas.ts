import { z } from "zod";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const overviewQuerySchema = z.object({
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  userId: z.string().optional(),
});
export type OverviewQuery = z.infer<typeof overviewQuerySchema>;

// Shared range query for the report endpoints. Both dates are optional;
// the service defaults the range to the last 30 days (see resolveDateRange).
export const reportRangeQuerySchema = z.object({
  startDate: dateString.optional(),
  endDate: dateString.optional(),
});
export type ReportRangeQuery = z.infer<typeof reportRangeQuerySchema>;

/**
 * Both ends required, unlike the report ranges above. The grid always knows
 * the week it is showing, and an open-ended holiday query would scan an
 * organisation's whole calendar to render seven cells.
 */
export const holidayRangeQuerySchema = z.object({
  startDate: dateString,
  endDate: dateString,
});
export type HolidayRangeQuery = z.infer<typeof holidayRangeQuerySchema>;
