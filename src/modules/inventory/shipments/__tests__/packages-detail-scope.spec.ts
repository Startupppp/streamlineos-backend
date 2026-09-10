import { ConflictException, NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { invPackageLines } from "../../../../db/schema";
import { PackagesService } from "../packages.service";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import {
  cacheWith,
  dbWith,
  scopeClause,
  scopeOf,
  sqlText,
  type DbHarness,
} from "../../__tests__/warehouse-scope-harness";

/**
 * `list` was scoped and every command that takes a package id was not.
 *
 * A package carries no warehouse of its own, so the list attributes it through
 * its shipment or the order it is packing and admits it when EITHER is in the
 * caller's warehouses. `loadPackage` — the private funnel `reconciliation`,
 * `updateLines`, `close` and `reopen` all reach the row through — filtered on
 * `org_id` and the id alone, and `findOne` and `scan` each had their own
 * unscoped copy of the same read.
 *
 * Nothing downstream would have caught any of it, and that is a rule rather than
 * an omission: nothing on the packing bench posts stock, so the stock engine's
 * `assertLocationsInScope` — the check that made the equivalent adjustment hole
 * survivable — never runs on this path at all. What was open is the whole bench:
 * reading another building's carton with its manifest, replacing that manifest
 * outright through `updateLines`, closing a carton somebody there was still
 * packing, and reopening one they had closed.
 *
 * `create` was open in a different way. `shipmentId` came off the request body
 * and was checked by NOTHING — not the scope, not even the organisation — and it
 * counts, because `packedQuantities` reads every package standing for an order:
 * a carton hung off another warehouse's despatch takes room off the
 * reconciliation the packer there is measured against, and their next legitimate
 * scan is refused for goods in their hand.
 */

const ORG = "org-1";

function serviceWith(
  harness: DbHarness,
  scope: WarehouseScopeService,
  cache: unknown,
  numSeq: unknown = { next: () => Promise.resolve("PKG-0001") },
) {
  return new PackagesService(
    harness.db,
    cache as never,
    numSeq as never,
    { assertFits: () => Promise.resolve(undefined) } as never,
    { insert: () => Promise.resolve(undefined) } as never,
    scope,
    { scan: () => Promise.resolve({ lookup: { type: "not_found" } }) } as never,
  );
}

const OPEN_PKG = {
  id: 42,
  orgId: ORG,
  status: "OPEN",
  soId: null,
  shipmentId: null,
  cartonTypeId: null,
};

describe("one package, read by id", () => {
  it("is unreachable for a caller holding no warehouse, and answers not found", async () => {
    /*
     * The PREDICATE is the assertion, not the throw. The fixture answers with no
     * row whichever way the service is written, so `rejects` alone would pass
     * against the unscoped code it was written to reject. An empty scope
     * compiles BOTH arms to `… AND FALSE`, and that is what a database acts on.
     *
     * 404 rather than 403 (§4): "forbidden" on a package id is an existence
     * oracle.
     */
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope, cache).findOne(ORG, "nobody-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(harness.wheres[0] as SQL);
    expect(text).toContain("inv_shipments WHERE org_id = $3 AND FALSE");
    expect(text).toContain("inv_sales_orders WHERE org_id = $4 AND FALSE");
    // One read, not two — a gate that threw after loading the header would
    // already have put the manifest on the wire.
    expect(harness.wheres).toHaveLength(1);
  });

  it("narrows a scoped caller through either attribution, and excludes a carton anchored to neither", async () => {
    /*
     * OR, not AND: requiring both would hide a carton whose order is in scope
     * purely because its shipment column is still null at the bench.
     *
     * The NULL rule falls out of that and differs by table on purpose, so its
     * absence is asserted rather than merely left out. `NULL IN (…)` is NULL and
     * `NULL OR NULL` is NULL, so a package anchored to neither document is
     * INVISIBLE to a scoped operator — which is what the list has always done.
     */
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7, 9]);

    await expect(
      serviceWith(harness, scope, cache).findOne(ORG, "packer-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(harness.wheres[0] as SQL);
    expect(text).toContain("inv_shipments WHERE org_id = $3 AND warehouse_id IN ($4, $5)");
    expect(text).toContain("inv_sales_orders WHERE org_id = $6 AND warehouse_id IN ($7, $8)");
    expect(text).toContain(" OR ");
    expect(text).not.toContain("IS NULL");
  });

  it("consults the scope even for an org-wide reader, and then narrows nothing", async () => {
    // "No predicate" cannot on its own tell an UNRESTRICTED reader from an
    // UNSCOPED method — which is the defect — so the absence is asserted
    // alongside proof that the scope was resolved at all.
    const harness = dbWith({ reads: [[OPEN_PKG], []] });
    const { cache } = cacheWith();
    const { service: scope, consulted } = scopeOf(null);

    const detail = await serviceWith(harness, scope, cache).findOne(ORG, "auditor-1", 42);

    expect(detail.id).toBe(42);
    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(sqlText(harness.wheres[0] as SQL)).not.toContain("inv_shipments");
  });

  it("keys the cached detail by the scope, so one caller's answer is not served to the next", async () => {
    // §6. A perfect WHERE clause under the old `detail:<id>` key would store the
    // packer's narrowed answer and hand it to the auditor, leaving this read
    // worse than the unscoped one it replaces — and every other case in this
    // file would still pass.
    const { cache, keys } = cacheWith();

    for (const [warehouses, user] of [
      [[7], "packer-1"],
      [[9], "other-packer-1"],
      [null, "auditor-1"],
    ] as [number[] | null, string][]) {
      const harness = dbWith({ reads: [[OPEN_PKG], []] });
      const { service: scope } = scopeOf(warehouses);
      await serviceWith(harness, scope, cache).findOne(ORG, user, 42);
    }

    expect(keys).toEqual(["detail:7:42", "detail:9:42", "detail:all:42"]);
    expect(new Set(keys).size).toBe(3);
  });

  it("builds exactly the predicate the list builds", async () => {
    /*
     * The drift guard, and the reason the predicate lives in one private method
     * rather than a second copy. Two hand-copied predicates agreeing today is
     * not the same as them being one predicate: this list gained its scope and
     * every read beside it was simply never told, which is the whole defect.
     */
    const { service: scope } = scopeOf([7, 9]);

    const list = dbWith();
    const { cache: listCache } = cacheWith();
    await serviceWith(list, scope, listCache).list(ORG, "packer-1", { page: 1, limit: 20 } as never);

    const detail = dbWith();
    const { cache: detailCache } = cacheWith();
    await expect(
      serviceWith(detail, scope, detailCache).findOne(ORG, "packer-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    const fromList = scopeClause(sqlText(list.wheres[0] as SQL), "inv_packages");
    const fromDetail = scopeClause(sqlText(detail.wheres[0] as SQL), "inv_packages");
    expect(fromList).toContain("inv_shipments");
    expect(fromDetail).toBe(fromList);
  });
});

describe("the commands that come through the funnel", () => {
  /**
   * `reconciliation`, `updateLines`, `close` and `reopen` all reach the row
   * through `loadPackage`, so the gate lives there rather than at each of the
   * four — the next command that loads a package by id is then gated by
   * construction.
   */
  it.each([
    [
      "reads the reconciliation",
      (svc: PackagesService) => svc.reconciliation(ORG, "nobody-1", 42),
    ],
    [
      "replaces the whole manifest",
      (svc: PackagesService) =>
        svc.updateLines(ORG, "nobody-1", 42, {
          lines: [{ productVariantId: 1, quantity: "99", lotId: null, serialId: null }],
        } as never),
    ],
    ["closes the carton", (svc: PackagesService) => svc.close(ORG, "nobody-1", 42)],
    ["reopens a closed carton", (svc: PackagesService) => svc.reopen(ORG, "nobody-1", 42)],
  ])("refuses one outside the caller's warehouses when it %s", async (_name, run) => {
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(run(serviceWith(harness, scope, cache))).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(sqlText(harness.wheres[0] as SQL)).toContain("AND FALSE");
    /*
     * Nothing written, and nothing even attempted. `rejects` on its own would be
     * satisfied by a service that replaced the manifest and refused afterwards,
     * which is the failure mode these three assertions exist to catch.
     */
    expect(harness.updates).toHaveLength(0);
    expect(harness.inserts).toHaveLength(0);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("lets an unrestricted caller's close run to completion", async () => {
    /*
     * The pass-through, asserted on a completed WRITE rather than on a rule
     * behind the gate: `close` updates through the injected handle rather than
     * the transaction one, so the whole command is observable here.
     */
    const harness = dbWith({ reads: [[OPEN_PKG], [], [{ ...OPEN_PKG, status: "CLOSED" }], []] });
    const { cache } = cacheWith();
    const { service: scope, consulted } = scopeOf(null);

    const closed = await serviceWith(harness, scope, cache).close(ORG, "auditor-1", 42);

    expect(closed.status).toBe("CLOSED");
    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(sqlText(harness.wheres[0] as SQL)).not.toContain("inv_shipments");
    expect(harness.updates).toHaveLength(1);
  });

  it("still refuses on the STATUS once the warehouse gate is passed", async () => {
    // So the refusals above are proved to be about the scope rather than about
    // the fixture answering nothing.
    const harness = dbWith({ reads: [[{ ...OPEN_PKG, status: "CLOSED" }]] });
    const { cache } = cacheWith();
    const { service: scope } = scopeOf(null);

    await expect(
      serviceWith(harness, scope, cache).close(ORG, "auditor-1", 42),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.updates).toHaveLength(0);
  });
});

/**
 * The scan path runs entirely inside one claimed transaction, and the shared
 * harness's transaction handle deliberately offers no `insert` — so a gate that
 * failed to refuse fails loudly there rather than passing quietly. `scan` claims
 * its key through that handle, so it needs one that records instead.
 */
function scanHarness(pkg: unknown) {
  const wheres: SQL[] = [];
  const written: unknown[] = [];

  const readChain: Record<string, unknown> = {
    from: () => readChain,
    where: (statement: SQL) => {
      wheres.push(statement);
      return readChain;
    },
    limit: () => Promise.resolve(pkg === undefined ? [] : [pkg]),
  };

  const tx = {
    select: () => readChain,
    execute: () => Promise.resolve([]),
    insert: (table: unknown) => ({
      values: (rows: unknown) => {
        if (table === invPackageLines) written.push(rows);
        return {
          // The idempotency claim; a package line is awaited directly.
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }),
          then: (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
            Promise.resolve([]).then(resolve, reject),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: () => {
          if (table === invPackageLines) written.push(values);
          return Promise.resolve(undefined);
        },
      }),
    }),
  };

  const transaction = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(tx)));
  return { db: { transaction } as never, wheres, written, transaction };
}

describe("scanning into a package", () => {
  it("refuses a carton outside the caller's warehouses, and records nothing in it", async () => {
    /*
     * The gate rides the read the claim already makes, so it sees the same
     * snapshot the write does and a refusal rolls the claim back with it. 404
     * before the STATUS is ever consulted: a ConflictException on a package the
     * caller may not see would report its state to them.
     */
    const harness = scanHarness(undefined);
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);
    const svc = serviceWith({ ...harness, updates: [], inserts: [] } as never, scope, cache);

    await expect(
      svc.scan(ORG, "nobody-1", 42, { productVariantId: 5, quantity: "1" } as never, "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("AND FALSE");
    // The line is the whole damage; `rejects` alone would not see it.
    expect(harness.written).toHaveLength(0);
  });

  it("applies the list's own predicate for a scoped packer", async () => {
    const harness = scanHarness(undefined);
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);
    const svc = serviceWith({ ...harness, updates: [], inserts: [] } as never, scope, cache);

    await expect(
      svc.scan(ORG, "packer-1", 42, { productVariantId: 5, quantity: "1" } as never, "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(harness.wheres[0] as SQL);
    expect(text).toContain("inv_shipments WHERE org_id = $3 AND warehouse_id IN ($4)");
    expect(text).toContain("inv_sales_orders WHERE org_id = $5 AND warehouse_id IN ($6)");
    expect(harness.written).toHaveLength(0);
  });
});

describe("raising a package", () => {
  it("refuses a shipment the caller cannot see, and inserts nothing", async () => {
    /*
     * Checked by nothing before this — not the scope, not the organisation.
     * Measured by the SHIPMENT's own rule, its warehouse column, and answered
     * 404 so naming an id you cannot see does not confirm it exists.
     */
    const harness = dbWith({ reads: [[]] });
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      serviceWith(harness, scope, cache).create(ORG, "packer-1", {
        shipmentId: 55,
        lines: [],
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain('"inv_shipments"."warehouse_id" IN');
    expect(harness.inserts).toHaveLength(0);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("lets an unrestricted caller name any of the org's shipments", async () => {
    /*
     * The counterpart, marked with a sentinel rather than a completed write: the
     * shared harness's transaction handle offers no `insert` on purpose, so
     * reaching the number sequence is the furthest an assertion can follow the
     * command — and that is already past the gate. The scope narrows nothing
     * here, so what answers is the organisation check this gate also introduced.
     */
    const harness = dbWith({ reads: [[{ id: 55 }]] });
    const { cache } = cacheWith();
    const { service: scope, consulted } = scopeOf(null);
    const numSeq = { next: () => Promise.reject(new Error("reached the number sequence")) };

    await expect(
      serviceWith(harness, scope, cache, numSeq).create(ORG, "auditor-1", {
        shipmentId: 55,
        lines: [],
      } as never),
    ).rejects.toThrow(/reached the number sequence/);

    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(sqlText(harness.wheres[0] as SQL)).not.toContain("warehouse_id IN");
    expect(harness.inserts).toHaveLength(0);
  });

  /**
   * The OTHER arm of the same predicate.
   *
   * Closing `shipmentId` closed one half of `packageInScope`. `soId` came off
   * the same request body and kept an ORG-MEMBERSHIP check alone, so a carton
   * could still be hung off an order in a building the caller has never stood
   * in — and it counts for exactly the reason the shipment arm counts:
   * `packedQuantities` reads every package standing for an order, so the carton
   * takes room off the reconciliation the legitimate packer there is measured
   * against and their next scan is refused for goods in their hand.
   */
  it("refuses a sales order the caller cannot see, and inserts nothing", async () => {
    const harness = dbWith({ reads: [[]] });
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      serviceWith(harness, scope, cache).create(ORG, "packer-1", {
        soId: 77,
        lines: [],
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain('"inv_sales_orders"."warehouse_id" IN');
    expect(harness.inserts).toHaveLength(0);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("refuses an out-of-scope order even when the shipment named beside it IS in scope", async () => {
    /*
     * The regression the shipment fix left behind, and the reason the case
     * above is not enough on its own: with only that one, a service that gated
     * NOTHING on `soId` and simply refused earlier on the shipment would still
     * pass. Here the shipment read ANSWERS — the caller genuinely holds that
     * despatch — so the only thing that can refuse is the order's own arm, and
     * the refusal is named to prove which one spoke.
     */
    const harness = dbWith({ reads: [[{ id: 55 }], []] });
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      serviceWith(harness, scope, cache).create(ORG, "packer-1", {
        shipmentId: 55,
        soId: 77,
        lines: [],
      } as never),
    ).rejects.toThrow(/Sales order not found/);

    expect(sqlText(harness.wheres[1] as SQL)).toContain('"inv_sales_orders"."warehouse_id" IN');
    expect(harness.inserts).toHaveLength(0);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("lets an unrestricted caller name any of the org's orders", async () => {
    // The pass-through, and it needs no branch of its own: `scope.warehouse`
    // compiles to `TRUE`, leaving the organisation check that was always there.
    const harness = dbWith({ reads: [[{ id: 77 }]] });
    const { cache } = cacheWith();
    const { service: scope, consulted } = scopeOf(null);
    const numSeq = { next: () => Promise.reject(new Error("reached the number sequence")) };

    await expect(
      serviceWith(harness, scope, cache, numSeq).create(ORG, "auditor-1", {
        soId: 77,
        lines: [],
      } as never),
    ).rejects.toThrow(/reached the number sequence/);

    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    const text = sqlText(harness.wheres[0] as SQL);
    expect(text).toContain('"inv_sales_orders"."org_id"');
    expect(text).not.toContain("warehouse_id IN");
    expect(harness.inserts).toHaveLength(0);
  });

  it("measures the order by the same rule the list's own order arm applies", async () => {
    /*
     * The drift guard. Two hand-written readings of "which orders may this
     * caller see" agreeing today is not the same as them being one rule — that
     * is precisely how this arm was left behind when the shipment arm was
     * closed. Compared as compiled SQL with placeholder numbers normalised
     * away, since the list binds its own filters first.
     */
    const { service: scope } = scopeOf([7, 9]);

    const list = dbWith();
    const { cache: listCache } = cacheWith();
    await serviceWith(list, scope, listCache).list(ORG, "packer-1", { page: 1, limit: 20 } as never);

    const raise = dbWith({ reads: [[]] });
    const { cache: raiseCache } = cacheWith();
    await expect(
      serviceWith(raise, scope, raiseCache).create(ORG, "packer-1", {
        soId: 77,
        lines: [],
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    const listArm = orderWarehouseClause(sqlText(list.wheres[0] as SQL));
    const raiseArm = orderWarehouseClause(sqlText(raise.wheres[0] as SQL));
    expect(listArm).toBe("warehouse_id IN ($?, $?)");
    expect(raiseArm).toBe(listArm);
  });
});

/**
 * The warehouse test the two sites apply to a sales order, with placeholder
 * NUMBERS normalised away.
 *
 * The list reaches the column through a subquery (`… WHERE org_id = $n AND
 * warehouse_id IN (…)`) because it is filtering `inv_packages`, while the raise
 * selects `inv_sales_orders` directly and so renders the column qualified. The
 * TEST is the same either way, and that is what this pulls out.
 */
function orderWarehouseClause(text: string): string {
  const match = /(?:"inv_sales_orders"\.)?"?warehouse_id"? IN \([^)]*\)/.exec(
    text.slice(text.indexOf("inv_sales_orders")),
  );
  return (match?.[0] ?? "").replace(/"inv_sales_orders"\./g, "").replace(/"/g, "").replace(/\$\d+/g, "$?");
}
