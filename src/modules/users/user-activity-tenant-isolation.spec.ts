import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
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

function makeQueryDb(memberRow: unknown) {
  const findFirst = jest.fn().mockResolvedValue(memberRow);
  const chain = {
    then: (fn: (v: unknown[]) => unknown) => Promise.resolve([]).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve([]).catch(fn),
    finally: (fn: () => void) => Promise.resolve([]).finally(fn),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
  };
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.offset.mockReturnValue(chain);
  const selectChain = { from: jest.fn().mockReturnValue(chain) };
  const db = {
    query: { organizationMembers: { findFirst } },
    select: jest.fn().mockReturnValue(selectChain),
  } as unknown as Db;
  return { db, findFirst };
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
