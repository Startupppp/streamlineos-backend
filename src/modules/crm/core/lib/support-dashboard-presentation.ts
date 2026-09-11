/**
 * How support statuses and priorities are PRESENTED, and the trend arithmetic.
 *
 * These four maps used to be declared inside `buildSupportDashboard`, rebuilt on
 * every request, which also meant a label or a colour could only be found by
 * reading 260 lines of query code. They describe display, not computation, and
 * the dashboard is the only thing that decides what "IN_PROGRESS" is called.
 *
 * `computeTrend` sits here for the same reason: it turns two counts into a
 * percentage and a direction for a chip, and its one real decision — that a
 * previous period of zero is reported as no change rather than as infinity — is
 * a presentation choice, not a measurement.
 */

export const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  WAITING: "Waiting",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

export const STATUS_COLORS: Record<string, string> = {
  OPEN: "#3B82F6",
  IN_PROGRESS: "#F59E0B",
  WAITING: "#8B5CF6",
  RESOLVED: "#10B981",
  CLOSED: "#6366F1",
};

export const PRIORITY_LABELS: Record<string, string> = {
  URGENT: "Urgent",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

export const PRIORITY_COLORS: Record<string, string> = {
  URGENT: "#EF4444",
  HIGH: "#F59E0B",
  MEDIUM: "#3B82F6",
  LOW: "#10B981",
};

export function computeTrend(current: number, previous: number) {
  if (previous === 0) return { value: 0, isPositive: true };
  const change = ((current - previous) / previous) * 100;
  return {
    value: Math.round(Math.abs(change) * 10) / 10,
    isPositive: change >= 0,
  };
}
