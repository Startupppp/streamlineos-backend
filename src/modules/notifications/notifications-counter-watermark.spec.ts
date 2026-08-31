import type { Db } from "../../db/drizzle.module";
import { NotificationsReadService } from "./notifications-read.service";

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

describe("NotificationsReadService — unread counter watermark", () => {
  const ORG = "org-a";
  const USER = "user-1";

  function makeDb(watermarkId: number): { db: Db; capturedCountWhere: unknown[] } {
    const capturedCountWhere: unknown[] = [];
    let callIndex = 0;
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockImplementation(() => ({
          where: jest.fn().mockImplementation((arg: unknown) => {
            callIndex++;
            if (callIndex === 1) return Promise.resolve(watermarkId > 0 ? [{ lastReadId: watermarkId }] : []);
            capturedCountWhere.push(arg);
            return Promise.resolve([{ count: 3 }]);
          }),
        })),
      })),
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
});
