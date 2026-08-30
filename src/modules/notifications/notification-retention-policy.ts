/**
 * C21-05 — Retention policy for the three high-volume notification tables.
 *
 * These tables are the subject of c21-04's partitioning. Retention here removes old
 * partitions by DETACH PARTITION CONCURRENTLY + DROP TABLE — never a bulk DELETE, which
 * on a table this size is an outage. The service is written and tested now; the actual
 * DETACH calls become effective once c21-04 creates the partitions.
 *
 * Partition naming convention (agreed with c21-04): {table_name}_y{year}_m{month:02}
 * e.g. notifications_y2025_m01, chat_messages_y2025_m01, notification_outbox_y2025_m01
 *
 * Windows are deliberate decisions, not omissions:
 *   notifications        — 180 days. Personal delivery records; supports dispute
 *                          resolution and read-receipt accuracy within six months.
 *   chat_messages        — 365 days. Operational history; longer than notifications
 *                          because threads are referenced across time.
 *   notification_outbox  — 90 days. Intent log; once processed it is redundant, and
 *                          an unprocessed row after 90 days indicates a stuck relay.
 */
export const NOTIFICATION_RETENTION_POLICY = {
  notifications: { retainDays: 180 },
  chat_messages: { retainDays: 365 },
  notification_outbox: { retainDays: 90 },
} as const satisfies Record<string, { retainDays: number }>;

export type RetainedTable = keyof typeof NOTIFICATION_RETENTION_POLICY;

/**
 * Names of partitions that should be detached and dropped for a given table, based
 * on the retention window and today's date. Returns the monthly partition names
 * (oldest first) that lie entirely before the cutoff.
 *
 * A partition covers one calendar month. It is eligible for removal when the month's
 * last day is strictly before the cutoff date — so February 2025 is eligible after
 * the retention window from its last day (2025-02-28) has elapsed.
 */
export function expiredPartitions(table: RetainedTable, now: Date): string[] {
  const { retainDays } = NOTIFICATION_RETENTION_POLICY[table];
  const cutoff = new Date(now.getTime() - retainDays * 86_400_000);

  const names: string[] = [];
  const cursor = new Date(Date.UTC(2024, 0, 1));

  while (cursor < cutoff) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;

    const lastDayOfMonth = new Date(Date.UTC(year, month, 0));
    if (lastDayOfMonth < cutoff) {
      const tag = `${table}_y${year}_m${String(month).padStart(2, "0")}`;
      names.push(tag);
    }

    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return names;
}
