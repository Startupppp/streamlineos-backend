import { NotificationVisibilityRegistry } from "./notification-visibility.registry";
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

function makeDb(count: number): { db: Db; capturedCountWhere: unknown[]; capturedSubKey: string[] } {
  const capturedCountWhere: unknown[] = [];
  const capturedSubKey: string[] = [];
  const db = {
    select: jest.fn().mockImplementation((fields: Record<string, unknown>) => {
      const fieldNames = Object.keys(fields ?? {});
      const isRecipient = fieldNames.includes("membershipId");
      const rows = isRecipient
        ? [{ membershipId: 7, lastReadId: null }]
        : [{ count }];
      const where = jest.fn().mockImplementation((arg: unknown) => {
        if (!isRecipient) capturedCountWhere.push(arg);
        return Promise.resolve(rows);
      });
      const from = jest.fn().mockImplementation(() => ({
        where,
        leftJoin: jest.fn().mockImplementation(() => ({ where })),
      }));
      return { from };
    }),
  } as unknown as Db;

  const cache = {
    cachedVersioned: jest.fn().mockImplementation(
      (_ns: unknown, key: unknown, fn: () => unknown) => {
        if (typeof key === "string") capturedSubKey.push(key);
        return fn();
      },
    ),
  } as never;

  return { db, capturedCountWhere, capturedSubKey };
}

const ORG = "org-a";
const ATTACKER_ORG = "org-attacker";
const USER = "user-1";

describe("NotificationsReadService — unread count with sourceModule filter", () => {
  it("the unread count with no sourceModule is unchanged, so the header bell is not affected", async () => {
    const { db, capturedCountWhere, capturedSubKey } = makeDb(5);
    const cache = {
      cachedVersioned: jest.fn().mockImplementation(
        (_ns: unknown, key: unknown, fn: () => unknown) => {
          if (typeof key === "string") capturedSubKey.push(key);
          return fn();
        },
      ),
    } as never;
    const svc = new NotificationsReadService(db, cache, new NotificationVisibilityRegistry());

    const result = await svc.unreadCount(ORG, USER);

    expect(result).toEqual({ count: 5 });
    expect(capturedSubKey[0]).toBe("unread-count");
    const vals = capturedCountWhere.flatMap((w) => sqlValues(w));
    expect(vals).not.toContain("build");
  });

  it("the Build badge and the /build/inbox list count the same rows — both filter sourceModule='build'", async () => {
    const { db, capturedCountWhere, capturedSubKey } = makeDb(3);
    const cache = {
      cachedVersioned: jest.fn().mockImplementation(
        (_ns: unknown, key: unknown, fn: () => unknown) => {
          if (typeof key === "string") capturedSubKey.push(key);
          return fn();
        },
      ),
    } as never;
    const svc = new NotificationsReadService(db, cache, new NotificationVisibilityRegistry());

    const result = await svc.unreadCount(ORG, USER, "build");

    expect(result).toEqual({ count: 3 });
    expect(capturedSubKey[0]).toBe("unread-count:build");
    const vals = capturedCountWhere.flatMap((w) => sqlValues(w));
    expect(vals).toContain("build");
  });

  it("a notification from another module is excluded from the Build count — sourceModule predicate is present", async () => {
    const { db, capturedCountWhere } = makeDb(0);
    const cache = {
      cachedVersioned: jest.fn().mockImplementation(
        (_ns: unknown, _key: unknown, fn: () => unknown) => fn(),
      ),
    } as never;
    const svc = new NotificationsReadService(db, cache, new NotificationVisibilityRegistry());

    await svc.unreadCount(ORG, USER, "build");

    const vals = capturedCountWhere.flatMap((w) => sqlValues(w));
    expect(vals).toContain("build");
    expect(vals).not.toContain("hr");
    expect(vals).not.toContain("chat");
  });

  it("cross-tenant isolation on the filtered count — orgId scopes the query even with sourceModule", async () => {
    const { db, capturedCountWhere } = makeDb(2);
    const cache = {
      cachedVersioned: jest.fn().mockImplementation(
        (_ns: unknown, _key: unknown, fn: () => unknown) => fn(),
      ),
    } as never;
    const svc = new NotificationsReadService(db, cache, new NotificationVisibilityRegistry());

    await svc.unreadCount(ORG, USER, "build");

    const vals = capturedCountWhere.flatMap((w) => sqlValues(w));
    expect(vals).toContain(ORG);
    expect(vals).toContain("build");
    expect(vals).not.toContain(ATTACKER_ORG);
  });
});
