import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InvProjectsService, PROJECT_REQUIREMENT_SOURCE } from "../inv-projects.service";

/**
 * B1 — every project surface is scoped, and every gate holds.
 *
 * The service is exercised with hand-built collaborators rather than through the
 * Nest container: what is under test is the predicate it builds and the order it
 * checks things in, and a mocked module hides both.
 */
function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const OWNER = "org-owner";
const ATTACKER = "org-attacker";

function makeDb(rows: unknown[] = []) {
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  const findMany = jest.fn().mockResolvedValue(rows);
  const handler = { findFirst, findMany };
  const whereCalls: unknown[] = [];

  /**
   * A chainable that is also awaitable: Drizzle's builder resolves wherever the
   * caller stops chaining, and this service stops in three different places
   * (`.where`, `.orderBy`, `.offset`). A mock that only resolves at one of them
   * silently voids whichever assertion sits behind the others.
   */
  function node(): Record<string, unknown> {
    const self: Record<string, unknown> = {
      from: () => node(),
      innerJoin: () => node(),
      leftJoin: () => node(),
      groupBy: () => node(),
      orderBy: () => node(),
      limit: () => node(),
      offset: () => node(),
      where: (...args: unknown[]) => {
        whereCalls.push(...args);
        return node();
      },
      then: (onOk: (v: unknown[]) => unknown) => Promise.resolve(rows).then(onOk),
    };
    return self;
  }

  const db = {
    select: jest.fn().mockImplementation(() => node()),
    query: new Proxy({} as Record<string, typeof handler>, { get: () => handler }),
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: () => ({ values: async () => [] }),
        update: () => ({ set: () => ({ where: async () => [] }) }),
      }),
    ),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }),
      }),
    }),
  };
  return { db, findFirst, findMany, whereCalls };
}

const cache = {
  cachedVersionedForOrg: jest.fn().mockImplementation(async (_o: string, _n: string, _h: string, fn: () => unknown) => fn()),
  invalidateNamespaceForOrg: jest.fn(),
};
const audit = { insert: jest.fn() };
const reservations = { createReservationInTx: jest.fn(), releaseReservationInTx: jest.fn() };
const warehouseScope = { assertWarehouseVisible: jest.fn() };

function build(db: unknown, packMaterials = true) {
  const settings = { get: jest.fn().mockResolvedValue({ packs: { materials: packMaterials } }) };
  return new InvProjectsService(
    db as never,
    cache as never,
    audit as never,
    settings as never,
    reservations as never,
    warehouseScope as never,
  );
}

const listFilters = { page: 1, limit: 25 } as never;

describe("InvProjectsService — the materials pack gate", () => {
  it("404s every project surface while the pack is off", async () => {
    const { db } = makeDb();
    const svc = build(db, false);
    await expect(svc.listProjects(OWNER, listFilters)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getProject(OWNER, 1)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.atRiskRequirements(OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("names the pack in the error so the operator can act on it", async () => {
    const { db } = makeDb();
    const svc = build(db, false);
    await expect(svc.listProjects(OWNER, listFilters)).rejects.toMatchObject({
      response: { code: "MATERIALS_PACK_DISABLED" },
    });
  });
});

describe("InvProjectsService — cross-tenant isolation", () => {
  it("binds the caller's org into every project list predicate", async () => {
    const { db, whereCalls } = makeDb([]);
    await build(db).listProjects(ATTACKER, listFilters);
    const bound = whereCalls.flatMap((c) => sqlValues(c));
    expect(bound).toContain(ATTACKER);
    expect(bound).not.toContain(OWNER);
  });

  it("404s another org's project rather than 403ing it (no existence oracle)", async () => {
    const { db, findFirst } = makeDb();
    findFirst.mockResolvedValue(null);
    await expect(build(db).getProject(ATTACKER, 4242)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s a requirement that belongs to another org's project", async () => {
    const { db, findFirst } = makeDb();
    findFirst.mockResolvedValue(null);
    await expect(
      build(db).updateRequirement(ATTACKER, "u1", 1, 9, { notes: "x" } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("re-asserts the variant's tenancy before writing a requirement", async () => {
    const { db, findFirst } = makeDb();
    // The project resolves; the variant does not.
    findFirst
      .mockResolvedValueOnce({ id: 1, status: "ACTIVE" })
      .mockResolvedValueOnce(null);
    await expect(
      build(db).addRequirement(ATTACKER, "u1", 1, {
        productVariantId: 77, requiredQty: "5",
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("InvProjectsService — write rules", () => {
  it("refuses material on a completed project", async () => {
    const { db, findFirst } = makeDb();
    findFirst.mockResolvedValue({ id: 1, status: "COMPLETED" });
    await expect(
      build(db).addRequirement(OWNER, "u1", 1, { productVariantId: 5, requiredQty: "5" } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses to reserve against a cancelled requirement", async () => {
    const { db, findFirst } = makeDb();
    findFirst.mockResolvedValue({
      id: 9, projectId: 1, productVariantId: 5, warehouseId: null,
      requiredQty: "10", fulfilledQty: "0", requiredBy: null, status: "CANCELLED",
    });
    await expect(
      build(db).reserveRequirement(OWNER, "u1", 1, 9, {} as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a release when nothing is held, rather than reporting a no-op as success", async () => {
    const { db, findFirst } = makeDb([]);
    findFirst.mockResolvedValue({
      id: 9, projectId: 1, productVariantId: 5, warehouseId: null,
      requiredQty: "10", fulfilledQty: "0", requiredBy: null, status: "REQUESTED",
    });
    await expect(build(db).releaseRequirement(OWNER, "u1", 1, 9)).rejects.toMatchObject({
      response: { code: "NO_ACTIVE_RESERVATION" },
    });
  });
});

describe("the project reservation source type", () => {
  it("is a single exported constant, so a hold can always be found again", () => {
    expect(PROJECT_REQUIREMENT_SOURCE).toBe("PROJECT_REQUIREMENT");
  });
});
