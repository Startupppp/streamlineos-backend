import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { encodeCursor } from "../../common/pagination/cursor";
import { UserActivityService } from "./user-activity.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const rec = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(rec.queryChunks ? sqlValues(rec.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec.value, seen) : []),
  ];
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";
const USER_ID = "user-abc";

function makeQueryDb(memberRow: unknown, activityRows: unknown[] = []) {
  const findFirst = jest.fn().mockResolvedValue(memberRow);
  const limit = jest.fn().mockResolvedValue(activityRows);
  const chain = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit,
  };
  const selectChain = { from: jest.fn().mockReturnValue(chain) };
  const db = {
    query: { organizationMembers: { findFirst } },
    select: jest.fn().mockReturnValue(selectChain),
  } as unknown as Db;
  return { db, findFirst };
}

function makeRow(id: number, createdAt: Date) {
  return {
    id,
    orgId: OWNER,
    targetId: USER_ID,
    actorUserId: null,
    action: "user.login",
    resourceType: null,
    resourceId: null,
    metadata: {},
    ipAddress: null,
    createdAt,
  };
}

describe("UserActivityService — cross-tenant isolation", () => {
  it("getUserActivity: throws NotFoundException for a member in a different org (deny)", async () => {
    const { db, findFirst } = makeQueryDb(null);
    const svc = new UserActivityService(db);
    await expect(svc.getUserActivity(ATTACKER, USER_ID)).rejects.toThrow(NotFoundException);
    expect(findFirst).toHaveBeenCalled();
    const whereArg = findFirst.mock.calls[0]?.[0]?.where;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
    expect(sqlValues(whereArg)).not.toContain(OWNER);
  });

  it("getUserActivity: returns activity for a member of the correct org (control)", async () => {
    const { db, findFirst } = makeQueryDb({ userId: USER_ID });
    const svc = new UserActivityService(db);
    const result = await svc.getUserActivity(OWNER, USER_ID);
    expect(result.data).toHaveLength(0);
    const whereArg = findFirst.mock.calls[0]?.[0]?.where;
    expect(sqlValues(whereArg)).toContain(OWNER);
  });
});

describe("UserActivityService — cursor stability", () => {
  it("getUserActivity: page 2 with a row inserted between reads does not repeat or skip", async () => {
    const t1 = new Date("2024-06-01T09:00:00Z");
    const t2 = new Date("2024-06-01T09:01:00Z");
    const t3 = new Date("2024-06-01T09:02:00Z");

    const page1Rows = [makeRow(3, t3), makeRow(2, t2), makeRow(1, t1)];
    const page2Rows = [makeRow(1, t1)];

    let callIdx = 0;
    const limit = jest.fn().mockImplementation(() =>
      Promise.resolve(callIdx++ === 0 ? page1Rows : page2Rows),
    );
    const chain = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit,
    };
    const db = {
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ userId: USER_ID }) } },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(chain) }),
    } as unknown as Db;

    const svc = new UserActivityService(db);

    const p1 = await svc.getUserActivity(OWNER, USER_ID, { limit: 2 });
    expect(p1.data.map((r) => r.id)).toEqual(["3", "2"]);
    expect(p1.pagination.nextCursor).not.toBeNull();

    const cursor = encodeCursor({ sortValue: t2.toISOString(), id: "2" });
    const p2 = await svc.getUserActivity(OWNER, USER_ID, { limit: 2, cursor });
    expect(p2.data.map((r) => r.id)).toEqual(["1"]);
    expect(p2.pagination.hasMore).toBe(false);

    const allIds = [...p1.data.map((r) => r.id), ...p2.data.map((r) => r.id)];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("nextCursor is null (never undefined) on the last page", async () => {
    const row = makeRow(1, new Date());
    const { db } = makeQueryDb({ userId: USER_ID }, [row]);
    const svc = new UserActivityService(db);

    const result = await svc.getUserActivity(OWNER, USER_ID, { limit: 20 });

    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.nextCursor).not.toBeUndefined();
  });
});
