import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { RolesQueryService } from "./roles-query.service";

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

function makeSelectDb(rows: unknown[] = []) {
  const where = jest.fn();
  const chain = {
    then: (fn: (v: unknown[]) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
    orderBy: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
  };
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.offset.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  where.mockReturnValue(chain);
  const from = jest.fn().mockReturnValue({ where, innerJoin: jest.fn().mockReturnValue({ leftJoin: jest.fn().mockReturnValue({ leftJoin: jest.fn().mockReturnValue({ where }) }) }) });
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

describe("RolesQueryService — cross-tenant isolation", () => {
  it("listAssignableDepartments: where predicate carries the attacker orgId (deny — results scoped per org)", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new RolesQueryService(db);
    const result = await svc.listAssignableDepartments(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("listAssignableDepartments: returns departments for the owning org (control)", async () => {
    const dept = { id: 1, name: "Engineering", kind: "DEPARTMENT" };
    const { db, where } = makeSelectDb([dept]);
    const svc = new RolesQueryService(db);
    const result = await svc.listAssignableDepartments(OWNER);
    expect(result).toHaveLength(1);
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(OWNER);
  });

  it("getSimulationTarget: throws NotFoundException for a member in a different org (deny)", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const db = { query: { organizationMembers: { findFirst } } } as unknown as Db;
    const svc = new RolesQueryService(db);
    await expect(svc.getSimulationTarget(ATTACKER, "user-1")).rejects.toThrow(NotFoundException);
    expect(findFirst).toHaveBeenCalled();
    const vals = sqlValues(findFirst.mock.calls[0]?.[0]?.where);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("getSimulationTarget: returns member info for the owning org (control)", async () => {
    const findFirst = jest.fn().mockResolvedValue({ isOwner: false });
    const db = { query: { organizationMembers: { findFirst } } } as unknown as Db;
    const svc = new RolesQueryService(db);
    const result = await svc.getSimulationTarget(OWNER, "user-1");
    expect(result.isOwner).toBe(false);
    const vals = sqlValues(findFirst.mock.calls[0]?.[0]?.where);
    expect(vals).toContain(OWNER);
  });
});
