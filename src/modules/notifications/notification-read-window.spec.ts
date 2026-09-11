import { notificationWindowStart, notificationWindowEnd } from "./notification-read-window";
import { expiredPartitions, NOTIFICATION_RETENTION_POLICY } from "./notification-retention-policy";

const DAY_MS = 86_400_000;

function monthsFrom2024(now: Date): { name: string; start: Date; end: Date }[] {
  const months: { name: string; start: Date; end: Date }[] = [];
  const cursor = new Date(Date.UTC(2024, 0, 1));
  while (cursor <= now) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    months.push({
      name: `notifications_y${year}_m${String(month).padStart(2, "0")}`,
      start: new Date(Date.UTC(year, month - 1, 1)),
      end: new Date(Date.UTC(year, month, 1)),
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

describe("notification read window", () => {
  const clocks = [
    new Date("2026-09-02T12:00:00.000Z"),
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2025-07-15T23:59:59.000Z"),
    new Date("2027-12-31T23:59:59.000Z"),
  ];

  it("never excludes a partition retention still keeps", () => {
    for (const now of clocks) {
      const start = notificationWindowStart(now);
      const expired = new Set(expiredPartitions("notifications", now));
      const retained = monthsFrom2024(now).filter((m) => !expired.has(m.name));
      expect(retained.length).toBeGreaterThan(0);
      for (const month of retained)
        expect(month.end.getTime()).toBeGreaterThan(start.getTime());
    }
  });

  it("excludes only months retention has already dropped", () => {
    for (const now of clocks) {
      const start = notificationWindowStart(now);
      const expired = new Set(expiredPartitions("notifications", now));
      const droppedByWindow = monthsFrom2024(now).filter(
        (m) => m.end.getTime() <= start.getTime(),
      );
      for (const month of droppedByWindow) expect(expired.has(month.name)).toBe(true);
    }
  });

  it("prunes: the window starts well after the oldest declared partition", () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    expect(notificationWindowStart(now).getTime()).toBeGreaterThan(Date.UTC(2026, 0, 1));
  });

  it("carries a day of slack at each end", () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    expect(notificationWindowEnd(now).getTime() - now.getTime()).toBe(DAY_MS);
    const cutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_POLICY.notifications.retainDays * DAY_MS);
    const monthStart = Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1);
    expect(monthStart - notificationWindowStart(now).getTime()).toBe(DAY_MS);
  });

  it("is a moving window, not a fixed date", () => {
    const a = notificationWindowStart(new Date("2026-03-10T00:00:00.000Z"));
    const b = notificationWindowStart(new Date("2026-09-10T00:00:00.000Z"));
    expect(b.getTime()).toBeGreaterThan(a.getTime());
  });
});
