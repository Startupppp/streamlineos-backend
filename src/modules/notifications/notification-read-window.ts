import { isNull, lte, or, type SQL } from "drizzle-orm";
import { notifications } from "../../db/schema";
import { NOTIFICATION_RETENTION_POLICY } from "./notification-retention-policy";

const DAY_MS = 86_400_000;

/**
 * `notifications` is RANGE-partitioned on `created_at`, so a read with no `created_at`
 * predicate cannot prune and plans a Merge Append over every declared partition —
 * 49 of them on the perf seed, costing 13,728 planning buffers to return 20 rows.
 * The window below is the retention horizon, not a page cap: retention detaches a
 * monthly partition once its last day falls before `now - retainDays`, so no row
 * older than the start of the month containing that cutoff survives. One day of
 * slack on each end absorbs the partition boundaries being stamped in the database
 * server's local timezone rather than UTC, and writer clock skew at the top end.
 */
export function notificationWindowStart(now: Date): Date {
  const { retainDays } = NOTIFICATION_RETENTION_POLICY.notifications;
  const cutoff = new Date(now.getTime() - retainDays * DAY_MS);
  const monthStart = Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1);
  return new Date(monthStart - DAY_MS);
}

export function notificationWindowEnd(now: Date): Date {
  return new Date(now.getTime() + DAY_MS);
}

export function notificationNotSnoozed(now: Date): SQL | undefined {
  return or(isNull(notifications.snoozedUntil), lte(notifications.snoozedUntil, now));
}
