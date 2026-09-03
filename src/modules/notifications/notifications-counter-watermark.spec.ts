import type { Db } from "../../db/drizzle.module";
import { NotificationsReadService } from "./notifications-read.service";
import { notificationWindowEnd, notificationWindowStart } from "./notification-read-window";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

/**
 * `sqlValues` drops Date bounds: a Date is `typeof "object"` with neither
 * `queryChunks` nor `value`, so it recurses to []. The retention-window bounds
 * are Dates, so pinning them needs its own collector.
 */
function sqlDates(v: unknown, seen = new Set<object>()): Date[] {
  if (v instanceof Date) return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlDates(i, seen));
  if (typeof v !== "object" || v === null || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlDates(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlDates(r.value, seen) : []),
  ];
}

describe("NotificationsReadService — unread counter watermark", () => {
  const ORG = "org-a";
  const USER = "user-1";

  function makeDb(watermarkId: number): { db: Db; capturedCountWhere: unknown[] } {
    const capturedCountWhere: unknown[] = [];
    const db = {
      select: jest.fn().mockImplementation((fields: Record<string, unknown>) => {
        const fieldNames = Object.keys(fields ?? {});
        const isRecipient = fieldNames.includes("membershipId");
        const isCount = fieldNames.includes("count");
        const rows = isRecipient
          ? [{ membershipId: 7, lastReadId: watermarkId > 0 ? watermarkId : null }]
          : isCount
            ? [{ count: 3 }]
            : [{ id: 7 }];
        const where = jest.fn().mockImplementation((arg: unknown) => {
          if (isCount) capturedCountWhere.push(arg);
          return Promise.resolve(rows);
        });
        const from = jest.fn().mockImplementation(() => ({
          where,
          leftJoin: jest.fn().mockImplementation(() => ({ where })),
        }));
        return { from };
      }),
    } as unknown as Db;
    return { db, capturedCountWhere };
  }

  function makeCache() {
    return {
      cachedVersioned: jest.fn().mockImplementation(
        (_ns: unknown, _key: unknown, fn: () => unknown) => fn(),
      ),
    } as never;
  }

  it("embeds the watermark id in the count WHERE clause when lastReadId > 0", async () => {
    const WATERMARK = 100;
    const { db, capturedCountWhere } = makeDb(WATERMARK);
    const svc = new NotificationsReadService(db, makeCache());

    await svc.unreadCount(ORG, USER);

    const vals = capturedCountWhere.flatMap((w) => sqlValues(w));
    expect(vals).toContain(WATERMARK);
  });

  it("does not embed a zero bound in the count WHERE clause when no watermark is set", async () => {
    const { db, capturedCountWhere } = makeDb(0);
    const svc = new NotificationsReadService(db, makeCache());

    await svc.unreadCount(ORG, USER);

    const vals = capturedCountWhere.flatMap((w) => sqlValues(w));
    expect(vals).not.toContain(0);
  });

  it("scopes the count to the requesting org so a new arrival in another tenant is not counted", async () => {
    const { db, capturedCountWhere } = makeDb(0);
    const svc = new NotificationsReadService(db, makeCache());

    await svc.unreadCount(ORG, USER);

    const vals = capturedCountWhere.flatMap((w) => sqlValues(w));
    expect(vals).toContain(ORG);
    expect(vals).not.toContain("org-attacker");
  });

  /**
   * `notifications` is RANGE-partitioned on `created_at` across 49 declared partitions
   * on the perf seed. Without a `created_at` bound the count plans every one of them:
   * measured as `streamline_app` on `scratch_perf_seed`, 11,986 planning buffers and
   * 8.3-19.2 ms of planning against 2,351 buffers and 0.43-0.72 ms with the bound —
   * a 5.1x buffer regression on a query that runs on every authenticated page load,
   * for every user, in every tenant.
   *
   * `notification-read-window.spec.ts` pins the window HELPER, but nothing pinned that
   * the count actually applies it, so deleting the two bounds from `queryUnreadCount`
   * left every spec in this repo green while restoring the full 49-partition plan.
   * These assertions close that gap.
   */
  it("bounds the count by the retention window so 41 of 49 partitions prune at plan time", async () => {
    const { db, capturedCountWhere } = makeDb(0);
    const svc = new NotificationsReadService(db, makeCache());

    const before = new Date();
    await svc.unreadCount(ORG, USER);
    const after = new Date();

    const bounds = capturedCountWhere
      .flatMap((w) => sqlDates(w))
      .sort((a, b) => a.getTime() - b.getTime());

    // Both ends must be present: a lower bound alone still plans every future
    // partition, and an upper bound alone still plans the whole history.
    expect(bounds).toHaveLength(2);
    const [start, end] = bounds;

    // The lower bound is the retention horizon (a month boundary less a day of
    // slack), so it is stable across the microseconds this test spans.
    expect([
      notificationWindowStart(before).getTime(),
      notificationWindowStart(after).getTime(),
    ]).toContain(start.getTime());

    // The upper bound tracks `now`, so it is asserted as an interval rather than
    // an equality — an equality here would be flaky by construction.
    expect(end.getTime()).toBeGreaterThanOrEqual(notificationWindowEnd(before).getTime());
    expect(end.getTime()).toBeLessThanOrEqual(notificationWindowEnd(after).getTime());

    // The bound is only worth anything if it is narrower than the declared
    // partition range; an all-time window would satisfy the shape and prune nothing.
    expect(start.getTime()).toBeLessThan(end.getTime());
    expect(end.getTime() - start.getTime()).toBeLessThan(400 * 86_400_000);
  });
});
