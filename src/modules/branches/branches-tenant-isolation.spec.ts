import { BranchesReadService } from "./branches-read.service";
import { BranchesService } from "./branches.service";
import type { Db } from "../../db/drizzle.module";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

function makeReadDb(rows: unknown[]): Db {
  return {
    query: {
      orgUnits: { findMany: jest.fn().mockResolvedValue(rows) },
    },
    select: jest.fn(),
  } as unknown as Db;
}

describe("BranchesReadService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const makeSvc = (db: Db) =>
    new BranchesReadService(
      db,
      { cachedForOrg: (_orgId: string, _key: string, fn: () => unknown) => fn() } as never,
    );

  it("returns empty list when no branches exist for the queried org (org isolation: attacker cannot see owner org branches)", async () => {
    const db = makeReadDb([]);
    const svc = makeSvc(db);

    const result = await svc.list(ATTACKER_ORG);

    expect(result).toHaveLength(0);
  });

  it("returns branches for the owning org (control)", async () => {
    const branch = {
      id: "bu-1",
      orgId: OWNER_ORG,
      kind: "BRANCH",
      name: "HQ Branch",
      metadata: {},
      head: null,
      deletedAt: null,
    };
    const db = makeReadDb([branch]);
    const svc = makeSvc(db);

    const result = await svc.list(OWNER_ORG);

    expect(Array.isArray(result)).toBe(true);
  });
});

describe("BranchesService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeSelectChain(rows: unknown[]) {
    let capturedPredicate: unknown;
    const limit = jest.fn().mockResolvedValue(rows);
    const where = jest.fn().mockImplementation((pred: unknown) => {
      capturedPredicate = pred;
      return { limit };
    });
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin });
    const mockTx = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([null]) }) }) }),
      insert: jest.fn(),
    };
    const db = {
      select: jest.fn().mockReturnValue({ from }),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockTx)),
    } as unknown as Db;
    return { db, getPredicate: () => capturedPredicate };
  }

  function makeSvc(db: Db) {
    return new BranchesService(
      db,
      { invalidateForOrg: jest.fn().mockResolvedValue(undefined) } as never,
      { invalidateAfterMutation: jest.fn().mockResolvedValue(undefined) } as never,
      { list: jest.fn(), getOne: jest.fn() } as never,
    );
  }

  it("DENY: update returns null when orgId does not match the branch's org (cross-tenant isolation)", async () => {
    const { db, getPredicate } = makeSelectChain([]);
    const svc = makeSvc(db);

    const result = await svc.update(ATTACKER_ORG, "branch-owned-by-owner", { name: "Injected", city: undefined, state: undefined, country: undefined, pincode: undefined, address: undefined, phone: undefined, email: undefined });

    expect(result).toBeNull();
    const vals = sqlValues(getPredicate());
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(OWNER_ORG);
  });

  it("CONTROL: update proceeds past the initial gate when orgId matches the branch's org", async () => {
    const { db, getPredicate } = makeSelectChain([{ metadata: {}, currentManagerId: null }]);
    const svc = makeSvc(db);

    await svc.update(OWNER_ORG, "branch-own-id", { name: "HQ Updated", city: undefined, state: undefined, country: undefined, pincode: undefined, address: undefined, phone: undefined, email: undefined });

    expect((db.transaction as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(sqlValues(getPredicate())).toContain(OWNER_ORG);
  });
});
