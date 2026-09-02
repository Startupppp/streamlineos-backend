/**
 * Home widgets render a glance, not a report, so every list read is capped and
 * reports its own true total rather than truncating in silence.
 */
export const DASHBOARD_LIST_CAP = 100;

/**
 * Attendance is deduplicated per person after the read, so the row cap allows
 * several punches each and the aggregates come from their own count queries.
 */
export const DASHBOARD_ATTENDANCE_ROW_CAP = 500;

/**
 * Project ids feed an `IN (...)` clause, so the newest projects bound it rather
 * than every project the organization has ever created.
 */
export const DASHBOARD_PROJECT_ID_CAP = 200;

export interface BoundedDashboardList<T> {
  data: T[];
  total: number;
  hasMore: boolean;
}

export function boundedDashboardList<T>(
  rows: T[],
  total: number,
  cap: number = DASHBOARD_LIST_CAP,
): BoundedDashboardList<T> {
  return { data: rows.slice(0, cap), total, hasMore: total > cap };
}
