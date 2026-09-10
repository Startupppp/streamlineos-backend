import { HttpException, NotFoundException } from "@nestjs/common";
import { InvProjectsService } from "../inv-projects.service";

/**
 * B1 — where warehouse scope bites in this module, and where it deliberately
 * does not.
 *
 * A warehouse-scope census reads `inv-projects.service.ts` as ten un-gated
 * candidates. Nine of them are un-gated on purpose: a project is a demand
 * source, not a place, `inv_projects` carries no warehouse column and is not
 * missing one, and the header cannot follow its requirements because
 * `NULL IN (…)` is NULL — a project with no lines yet, or with lines nobody has
 * given a store to, would be invisible to exactly the planner whose job is to
 * fix that. The full reasoning is in the service's class docblock; this file is
 * the half that fails when somebody changes their mind without reading it.
 *
 * So there are two kinds of test here and both matter:
 *
 *   1. The gate. Reserving and releasing are claims on a warehouse — the
 *      controller already says so by giving them `inventory:stock:reserve`
 *      instead of the project key — and they are gated on the bin the stock
 *      actually stands in. Delete either call and these fail.
 *   2. The decision. The nine planning surfaces must not consult the warehouse
 *      scope at all. Add a scope to any of them and these fail. That is what
 *      stops the next census raising the same ten rows again.
 */

/** Every method a scoped surface could possibly reach for, so "none of them" is checkable. */
function makeWarehouseScope(scope: number[] | null = null) {
  const visibleLocations = new Set<number>();
  return {
    visibleLocations,
    resolve: jest.fn().mockResolvedValue(scope),
    forUser: jest.fn(),
    scopeKey: jest.fn().mockReturnValue("all"),
    warehousePredicate: jest.fn().mockReturnValue({ marker: "warehouse-predicate" }),
    locationPredicate: jest.fn().mockReturnValue({ marker: "location-predicate" }),
    warehouseIdList: jest.fn().mockReturnValue(null),
    assertWarehouseVisible: jest.fn().mockImplementation(async (_o: string, _u: string, id: number | null) => {
      if (scope !== null && (id == null || !scope.includes(id))) throw new NotFoundException("Not found");
    }),
    assertLocationVisible: jest.fn().mockImplementation(async (_o: string, _u: string, id: number | null) => {
      if (scope !== null && (id == null || !visibleLocations.has(id))) throw new NotFoundException("Not found");
    }),
    assertLocationsInScope: jest.fn(),
  };
}

type WarehouseScopeMock = ReturnType<typeof makeWarehouseScope>;

/** Every recorded call across the whole collaborator, so "it never asked" is one assertion. */
function scopeInteractions(scope: WarehouseScopeMock): string[] {
  return Object.entries(scope)
    .filter(([, value]) => typeof value === "function" && "mock" in (value as jest.Mock))
    .filter(([, value]) => (value as jest.Mock).mock.calls.length > 0)
    .map(([name]) => name);
}

/**
 * A db double whose `select()` results are queued in call order.
 *
 * The service issues several different selects per method and reads a different
 * shape from each; one shared row set would let a coverage aggregate answer a
 * reservation lookup and quietly make the assertion behind it vacuous.
 */
function makeDb(opts: { selects?: unknown[][]; findFirst?: unknown[] } = {}) {
  const selectQueue = [...(opts.selects ?? [])];
  const findFirstQueue = [...(opts.findFirst ?? [])];
  const whereCalls: unknown[] = [];
  const transaction = jest.fn();

  function node(result: unknown[]): Record<string, unknown> {
    const self: Record<string, unknown> = {
      from: () => node(result),
      innerJoin: () => node(result),
      leftJoin: () => node(result),
      groupBy: () => node(result),
      orderBy: () => node(result),
      limit: () => node(result),
      offset: () => node(result),
      where: (...args: unknown[]) => {
        whereCalls.push(...args);
        return node(result);
      },
      // Awaitable wherever the caller stops chaining — this service stops at
      // `.where`, `.orderBy`, `.groupBy` and `.offset` in different methods.
      then: (onOk: (v: unknown[]) => unknown) => Promise.resolve(result).then(onOk),
    };
    return self;
  }

  const txHandle = {
    insert: () => ({ values: async () => [] }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  };

  transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(txHandle));

  const findFirst = jest
    .fn()
    .mockImplementation(async () => (findFirstQueue.length > 0 ? findFirstQueue.shift() : null));

  const db = {
    select: jest.fn().mockImplementation(() => node(selectQueue.length > 0 ? selectQueue.shift()! : [])),
    query: new Proxy({} as Record<string, { findFirst: jest.Mock }>, { get: () => ({ findFirst }) }),
    execute: jest.fn().mockResolvedValue([]),
    transaction,
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }),
      }),
    }),
  };
  return { db, findFirst, whereCalls, transaction };
}

function build(db: unknown, warehouseScope: WarehouseScopeMock) {
  const cache = {
    cachedVersionedForOrg: jest.fn().mockImplementation(async (_o: string, _n: string, _h: string, fn: () => unknown) => fn()),
    invalidateNamespaceForOrg: jest.fn(),
  };
  const audit = { insert: jest.fn() };
  const settings = { get: jest.fn().mockResolvedValue({ packs: { materials: true } }) };
  const reservations = {
    createReservationInTx: jest.fn().mockResolvedValue({ id: 900 }),
    releaseReservationInTx: jest.fn().mockResolvedValue({ id: 900 }),
  };
  const svc = new InvProjectsService(
    db as never,
    cache as never,
    audit as never,
    settings as never,
    reservations as never,
    warehouseScope as never,
  );
  return { svc, reservations, audit, cache };
}

const ORG = "org-1";
const PICKER = "user-picker";
const PROJECT_ID = 1;
const REQUIREMENT_ID = 9;

const requirementRow = {
  id: REQUIREMENT_ID,
  projectId: PROJECT_ID,
  productVariantId: 5,
  warehouseId: null,
  requiredQty: "10",
  fulfilledQty: "0",
  requiredBy: null,
  status: "REQUESTED",
};

const projectRow = { id: PROJECT_ID, code: "HYD-01", name: "Tower", status: "ACTIVE" };

// ---------------------------------------------------------------------------
// 1. The gate: the two surfaces that are a claim on a warehouse.
// ---------------------------------------------------------------------------

describe("releaseRequirement — the hold you give back must be one you were shown", () => {
  /** Pune-only picker; the hold on this line stands in a Nashik bin. */
  function scopedToPune() {
    const scope = makeWarehouseScope([7]);
    scope.visibleLocations.add(70); // a bin inside warehouse 7
    return scope;
  }

  it("404s a release whose hold stands in a building the caller was never shown", async () => {
    const scope = scopedToPune();
    const { db, transaction } = makeDb({
      findFirst: [requirementRow],
      selects: [[{ id: 500, locationId: 99 }]], // bin 99 lives in somebody else's warehouse
    });
    const { svc, reservations } = build(db, scope);

    await expect(svc.releaseRequirement(ORG, PICKER, PROJECT_ID, REQUIREMENT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Refused BEFORE anything is written: the units stay committed and the line
    // keeps its status. A gate that threw after the transaction opened would
    // still have released the hold.
    expect(transaction).not.toHaveBeenCalled();
    expect(reservations.releaseReservationInTx).not.toHaveBeenCalled();
  });

  it("404s rather than 403s, so a refusal is not an existence oracle", async () => {
    const scope = scopedToPune();
    const { db } = makeDb({
      findFirst: [requirementRow],
      selects: [[{ id: 500, locationId: 99 }]],
    });
    const { svc } = build(db, scope);
    const err = await svc.releaseRequirement(ORG, PICKER, PROJECT_ID, REQUIREMENT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(404);
  });

  it("refuses a hold attributed to no bin at all — NULL is in nobody's scope", async () => {
    const scope = scopedToPune();
    const { db, transaction } = makeDb({
      findFirst: [requirementRow],
      selects: [[{ id: 500, locationId: null }]],
    });
    const { svc } = build(db, scope);
    await expect(svc.releaseRequirement(ORG, PICKER, PROJECT_ID, REQUIREMENT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses the whole release when only one of several holds is out of scope", async () => {
    const scope = scopedToPune();
    const { db, transaction } = makeDb({
      findFirst: [requirementRow],
      selects: [[{ id: 500, locationId: 70 }, { id: 501, locationId: 99 }]],
    });
    const { svc } = build(db, scope);
    await expect(svc.releaseRequirement(ORG, PICKER, PROJECT_ID, REQUIREMENT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Every hold is asserted before any is touched, so there is no partial release.
    expect(transaction).not.toHaveBeenCalled();
  });

  it("releases the hold standing in a building the caller does hold", async () => {
    const scope = scopedToPune();
    const { db } = makeDb({
      findFirst: [requirementRow],
      selects: [[{ id: 500, locationId: 70 }]],
    });
    const { svc, reservations } = build(db, scope);
    await expect(svc.releaseRequirement(ORG, PICKER, PROJECT_ID, REQUIREMENT_ID)).resolves.toEqual({ released: 1 });
    expect(reservations.releaseReservationInTx).toHaveBeenCalledTimes(1);
  });

  it("passes an org-wide caller through untouched — `scope === null` adds no predicate", async () => {
    const scope = makeWarehouseScope(null);
    const { db } = makeDb({
      findFirst: [requirementRow],
      selects: [[{ id: 500, locationId: 99 }]],
    });
    const { svc, reservations } = build(db, scope);
    await expect(svc.releaseRequirement(ORG, "user-admin", PROJECT_ID, REQUIREMENT_ID)).resolves.toEqual({
      released: 1,
    });
    expect(reservations.releaseReservationInTx).toHaveBeenCalledTimes(1);
  });
});

describe("reserveRequirement — the bin you take from must be one you were shown", () => {
  /**
   * Reserve already asserted the *named* warehouse. These cover the two ways in
   * that never named one, and the replacement half — without them the release
   * gate above becomes a trap, because a picker could create a hold in a building
   * they are then refused permission to release.
   */
  it("asserts a bare `locationId`, which skipped the warehouse assert entirely", async () => {
    const scope = makeWarehouseScope([7]);
    const { db, transaction } = makeDb({
      // The bin is owned by the org, so the tenancy check passes...
      findFirst: [requirementRow, { id: 99 }],
      selects: [
        [], // coverage: reservations held
        [], // coverage: availability
      ],
    });
    const { svc } = build(db, scope);

    await expect(
      svc.reserveRequirement(ORG, PICKER, PROJECT_ID, REQUIREMENT_ID, { locationId: 99 } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    // ...and scope is what refuses it.
    expect(scope.assertLocationVisible).toHaveBeenCalledWith(ORG, PICKER, 99);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("narrows the auto-resolved bin to the caller's warehouses", async () => {
    const scope = makeWarehouseScope([7]);
    scope.visibleLocations.add(70);
    const { db } = makeDb({
      findFirst: [requirementRow],
      selects: [
        [], // coverage: reservations held
        [], // coverage: availability
        [], // heldByLocation
        [{ locationId: 70, available: "100" }], // candidate bins
        [], // existing active holds
      ],
    });
    const { svc } = build(db, scope);
    await svc.reserveRequirement(ORG, PICKER, PROJECT_ID, REQUIREMENT_ID, {} as never);

    // The requirement names no store, so nothing else would have bounded this
    // search: without the predicate it ranges over every bin in the organisation.
    expect(scope.resolve).toHaveBeenCalledWith(ORG, PICKER);
    expect(scope.warehousePredicate).toHaveBeenCalledWith([7], expect.anything());
  });

  it("asserts the bin a replaced hold is standing in, not only the new one", async () => {
    const scope = makeWarehouseScope([7]);
    scope.visibleLocations.add(70);
    const { db, transaction } = makeDb({
      findFirst: [requirementRow],
      selects: [
        [], // coverage: reservations held
        [], // coverage: availability
        [], // heldByLocation
        [{ locationId: 70, available: "100" }], // candidate bins, in scope
        [{ id: 500, locationId: 99 }], // the standing hold is NOT
      ],
    });
    const { svc, reservations } = build(db, scope);

    await expect(
      svc.reserveRequirement(ORG, PICKER, PROJECT_ID, REQUIREMENT_ID, {} as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    // A top-up releases the standing hold before re-taking the total, so this is
    // the same act the release gate covers, reached by another door.
    expect(transaction).not.toHaveBeenCalled();
    expect(reservations.releaseReservationInTx).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. The decision: the nine planning surfaces are org-wide, on purpose.
// ---------------------------------------------------------------------------

describe("the project planning surface is org-wide, and that is a decision", () => {
  /**
   * Each case drives one method to completion with a scoped caller and asserts
   * the warehouse scope was never consulted — not resolved, not asked for a
   * predicate, not asked to assert anything.
   *
   * These fail the moment somebody scopes one of them. That is the point: the
   * reasoning lives in the service's class docblock and this is what makes it
   * cost something to contradict. If a future product decision genuinely makes a
   * project a per-warehouse object, the honest change is to give `inv_projects`
   * a warehouse column, delete the docblock and delete these — not to bolt a
   * requirements subquery onto the header and rediscover why it deadlocks.
   */

  it("listProjects answers for every site in the organisation", async () => {
    const scope = makeWarehouseScope([7]);
    const { db } = makeDb({ selects: [[], [{ count: 0 }]] });
    const { svc } = build(db, scope);
    await svc.listProjects(ORG, { page: 1, limit: 25 } as never);
    expect(scopeInteractions(scope)).toEqual([]);
  });

  it("getProject answers for a site drawing on stores the caller does not hold", async () => {
    const scope = makeWarehouseScope([7]);
    const { db } = makeDb({ findFirst: [projectRow], selects: [[]] });
    const { svc } = build(db, scope);
    await svc.getProject(ORG, PROJECT_ID);
    expect(scopeInteractions(scope)).toEqual([]);
  });

  it("coverageFor keeps availability the org-wide number a promise is made against", async () => {
    const scope = makeWarehouseScope([7]);
    const { db } = makeDb({
      selects: [
        [], // reservations held
        [{ productVariantId: 5, warehouseId: 99, available: "40" }],
      ],
    });
    const { svc } = build(db, scope);
    const [coverage] = await svc.coverageFor(ORG, [
      { id: REQUIREMENT_ID, productVariantId: 5, warehouseId: null, requiredQty: "10", fulfilledQty: "0", requiredBy: null },
    ]);
    // Availability from a warehouse the caller does not hold still counts —
    // the same settlement `/:soId/atp` reached: the number stays org-wide and
    // the gate goes on the claim.
    expect(Number(coverage?.availableQty)).toBe(40);
    expect(scopeInteractions(scope)).toEqual([]);
  });

  it("atRiskRequirements feeds the whole organisation's backlog", async () => {
    const scope = makeWarehouseScope([7]);
    const { db } = makeDb({ selects: [[]] });
    const { svc } = build(db, scope);
    await svc.atRiskRequirements(ORG, 25);
    expect(scopeInteractions(scope)).toEqual([]);
  });

  it("createProject does not ask which buildings the creator holds", async () => {
    const scope = makeWarehouseScope([7]);
    const { db } = makeDb();
    const { svc } = build(db, scope);
    await svc.createProject(ORG, PICKER, { code: "HYD-02", name: "Site" } as never);
    // The tail this avoids: a project has no requirements for the first second
    // of its life, so any scope derived from them would hide it from the person
    // who just created it — including from the addRequirement that would fix it.
    expect(scopeInteractions(scope)).toEqual([]);
  });

  it("updateProject edits the planning header without a warehouse question", async () => {
    const scope = makeWarehouseScope([7]);
    const { db } = makeDb({ findFirst: [{ ...projectRow, startsOn: null, endsOn: null }] });
    const { svc } = build(db, scope);
    await svc.updateProject(ORG, PICKER, PROJECT_ID, { name: "Renamed" } as never);
    expect(scopeInteractions(scope)).toEqual([]);
  });

  it("archiveProject is a planning act, protected by its reservation refusal instead", async () => {
    const scope = makeWarehouseScope([7]);
    const { db } = makeDb({ findFirst: [projectRow], selects: [[{ count: 0 }]] });
    const { svc } = build(db, scope);
    await svc.archiveProject(ORG, PICKER, PROJECT_ID);
    // Archiving cannot strand another building's stock: the method already
    // refuses while any active hold stands. That refusal is the protection here,
    // not a scope.
    expect(scopeInteractions(scope)).toEqual([]);
  });

  it("addRequirement may point a line at a store the caller does not hold", async () => {
    const scope = makeWarehouseScope([7]);
    const { db } = makeDb({ findFirst: [projectRow, { id: 5 }, { id: 99 }] });
    const { svc } = build(db, scope);
    await svc.addRequirement(ORG, PICKER, PROJECT_ID, {
      productVariantId: 5,
      warehouseId: 99,
      requiredQty: "10",
    } as never);
    // Naming a store on a requirement is an expectation — "we want this from
    // there" — not a claim on its stock. The claim is reserve, and reserve is
    // gated. Tenancy is still re-asserted; scope deliberately is not.
    expect(scopeInteractions(scope)).toEqual([]);
  });

  it("updateRequirement may re-point a line without holding either store", async () => {
    const scope = makeWarehouseScope([7]);
    const { db } = makeDb({ findFirst: [requirementRow] });
    const { svc } = build(db, scope);
    await svc.updateRequirement(ORG, PICKER, PROJECT_ID, REQUIREMENT_ID, { warehouseId: 99 } as never);
    // This is why the gate reads `inv_stock_reservations.location_id` and never
    // `inv_project_requirements.warehouse_id`: this column is editable, so a gate
    // built on it would answer for a building the units are not in.
    expect(scopeInteractions(scope)).toEqual([]);
  });
});
