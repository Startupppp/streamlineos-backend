import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { SlottingService } from "../slotting.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";

/**
 * Approving a re-slot decides two things, and only one was being checked.
 *
 * `approve` asked `assertLocationVisible` — "may this person SEE that bin" —
 * and nothing else. So an approver could accept "move 400 units to the gold
 * zone" and name a bin in cold storage: the recommendation recorded itself
 * APPROVED, its stored reason still said gold, and the transfer handed back
 * pointed somewhere else entirely.
 *
 * It also fetched the recommendation on `org_id` and its id alone, while `list`
 * beside it resolves the caller's warehouses — the same aggregate-scoped,
 * detail-unscoped shape found in the labour records and the ASN detail, except
 * this one ends with stock moving.
 */

const RECOMMENDATION = {
  id: 5,
  orgId: "org-1",
  warehouseId: 7,
  productVariantId: 11,
  fromLocationId: 100,
  toZoneLocationId: 200,
  quantity: "400.0000",
  status: "PENDING" as const,
  reason: "A-class stock standing in the back of the building",
};

/**
 * `execute` answers the descendant walk: `inZone` is the set of ids the CTE
 * would return for zone 200.
 */
function dbWith(rows: readonly unknown[], inZone: readonly number[]) {
  const wheres: SQL[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "update", "set", "returning"]) chain[method] = () => chain;
  chain["where"] = (statement: SQL) => {
    wheres.push(statement);
    return chain;
  };
  let read = 0;
  chain["then"] = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(read++ === 0 ? rows : [{ ...RECOMMENDATION, status: "APPROVED" }]).then(
      resolve,
      reject,
    );
  chain["execute"] = (statement: SQL) => {
    /*
     * The bound values, read the way the driver would read them, rather than by
     * poking at `queryChunks` — my first version did that and picked the wrong
     * one, so a bin that IS in the zone was reported as outside it.
     * The CTE binds org, zone, org, then the location being asked about.
     */
    const params = new PgDialect().sqlToQuery(statement).params;
    const asked = Number(params[params.length - 1]);
    return Promise.resolve(inZone.includes(asked) ? [{ id: asked }] : []);
  };
  return { db: chain as never, wheres };
}

function scopeOf(warehouseIds: number[] | null) {
  const service = new WarehouseScopeService(
    {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve((warehouseIds ?? []).map((warehouseId) => ({ warehouseId }))),
        }),
      }),
    } as never,
    {
      resolveUserPermissions: () =>
        Promise.resolve(new Set(warehouseIds === null ? ["inventory:warehouses:scope-all"] : [])),
    } as never,
  );
  service.assertLocationVisible = jest.fn(async () => {});
  return service;
}

function serviceWith(db: unknown, scope: WarehouseScopeService): SlottingService {
  return new SlottingService(db as never, { insert: jest.fn() } as never, scope);
}

describe("approving a re-slot recommendation", () => {
  it("refuses a bin outside the zone the recommendation points at", async () => {
    // Bin 999 is visible to this caller — `assertLocationVisible` passes — and
    // is in a different zone. That is the whole defect: visibility answered a
    // question nobody had asked.
    const { db } = dbWith([RECOMMENDATION], [201, 202]);
    const service = serviceWith(db, scopeOf([7]));

    await expect(service.approve("org-1", "supervisor-1", 5, 999)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("accepts a bin inside that zone", async () => {
    const { db } = dbWith([RECOMMENDATION], [201, 202]);
    const service = serviceWith(db, scopeOf([7]));

    const result = await service.approve("org-1", "supervisor-1", 5, 201);

    expect(result.move.toLocationId).toBe(201);
    expect(result.move.fromLocationId).toBe(100);
  });

  it("accepts the zone itself, which is inside itself", async () => {
    const { db } = dbWith([RECOMMENDATION], []);
    const service = serviceWith(db, scopeOf([7]));

    await expect(service.approve("org-1", "supervisor-1", 5, 200)).resolves.toBeDefined();
  });

  it("does not let a caller holding no warehouse approve anything", async () => {
    /*
     * Asserted on the REJECTION plus the fact that the recommendation was never
     * read: an implementation that fetched the row and then refused would still
     * have gone to the database on behalf of somebody with no standing, and the
     * `toEqual`-style assertion alone would not tell the two apart.
     */
    const { db, wheres } = dbWith([RECOMMENDATION], [201]);
    const service = serviceWith(db, scopeOf([]));

    await expect(service.approve("org-1", "nobody-1", 5, 201)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(wheres).toHaveLength(0);
  });

  it("hides a recommendation in a warehouse the caller does not hold", async () => {
    /*
     * The PREDICATE is the assertion. My first version checked only that this
     * rejects with NotFoundException, and it passed against the UNSCOPED code
     * too — the fixture returns no row either way, so the throw said nothing
     * about scoping. Reverting the fix failed two of five cases instead of
     * three, which is how I found it.
     *
     * A scoped miss reading as "not found" rather than "forbidden" is still
     * deliberate, and still worth having in the name: it keeps this from
     * becoming an oracle for which recommendations exist.
     */
    const { db, wheres } = dbWith([], [201]);
    const service = serviceWith(db, scopeOf([9]));

    await expect(service.approve("org-1", "supervisor-1", 5, 201)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(new PgDialect().sqlToQuery(wheres[0] as SQL).sql).toContain('"warehouse_id" IN ($3)');
  });
});
