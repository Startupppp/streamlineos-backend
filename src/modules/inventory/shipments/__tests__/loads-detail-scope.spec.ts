import { ConflictException, NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { LoadsService } from "../loads.service";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import {
  cacheWith,
  dbWith,
  scopeOf,
  sqlText,
  type DbHarness,
} from "../../__tests__/warehouse-scope-harness";

/**
 * `list` was scoped by the warehouse a load leaves from; nothing else was.
 *
 * `findOne` took no `userId` at all, so any load in the organisation could be
 * read whole by id — its destination, its vehicle, its carrier and every
 * shipment and transfer on it. `dispatch`, `close` and `cancel` had `userId` and
 * spent it only on the audit row, reaching the load on `org_id` and the id
 * alone. Cancelling somebody else's DRAFT load is the quiet one: nothing about
 * it is visible until the goods that were supposed to leave have not left.
 *
 * `create` was open twice over. `sourceWarehouseId` went from the request body
 * to the insert unchecked, so a load could be raised out of a building the
 * caller holds nothing in; and `shipmentIds`/`transferIds` were never checked
 * against anything AT ALL — not the scope, not even the organisation — so any
 * shipment in the tenant could be pulled onto a stranger's load, after which
 * dispatching it reads and reports their statuses.
 */

const ORG = "org-1";

function serviceWith(
  harness: DbHarness,
  scope: WarehouseScopeService,
  cache: unknown,
  numSeq: unknown = { next: () => Promise.resolve("LOAD-0001") },
) {
  return new LoadsService(
    harness.db,
    cache as never,
    numSeq as never,
    { insert: () => Promise.resolve(undefined) } as never,
    scope,
  );
}

/** The scope-bearing tail of a compiled predicate, `$n` normalised away. */
function sourceClause(statement: SQL): string {
  const text = sqlText(statement).replace(/\$\d+/g, "$?");
  const at = text.indexOf('"inv_loads"."source_warehouse_id"');
  expect(at).toBeGreaterThanOrEqual(0);
  return text.slice(at);
}

describe("one load, read by id", () => {
  it("is unreachable for a caller holding no warehouse, and answers not found", async () => {
    /*
     * The PREDICATE is the assertion, not the throw: this fixture answers with
     * no row whichever way the service is written, so `rejects` alone would pass
     * against the unscoped code it was written to reject. 404 rather than 403,
     * because "forbidden" on a load id confirms the load exists (§4).
     */
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope, cache).findOne(ORG, "nobody-1", 5),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    // One read, not two — a gate that threw after loading the header would have
    // already put the manifest on the wire.
    expect(harness.wheres).toHaveLength(1);
  });

  it("narrows a scoped caller to their own warehouses, with no IS NULL escape", async () => {
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7, 9]);

    await expect(
      serviceWith(harness, scope, cache).findOne(ORG, "picker-1", 5),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sourceClause(harness.wheres[0] as SQL)).toContain(
      '"inv_loads"."source_warehouse_id" IN ($?, $?)',
    );
    expect(sqlText(harness.wheres[0] as SQL)).not.toContain("IS NULL");
  });

  it("consults the scope even for an org-wide reader, and then narrows nothing", async () => {
    const harness = dbWith({ reads: [[{ id: 5, orgId: ORG }], []] });
    const { cache } = cacheWith();
    const { service: scope, consulted } = scopeOf(null);

    const detail = await serviceWith(harness, scope, cache).findOne(ORG, "auditor-1", 5);

    expect(detail.id).toBe(5);
    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(sqlText(harness.wheres[0] as SQL)).not.toContain("source_warehouse_id");
  });

  it("keys the cached detail by the scope, so one caller's answer is not served to the next", async () => {
    // §6. A perfect WHERE clause under the old `detail:<id>` key would leave
    // this read worse than the unscoped one it replaces, and every other case in
    // this file would still pass.
    const { cache, keys } = cacheWith();

    for (const [warehouses, user] of [
      [[7], "picker-1"],
      [[9], "other-picker-1"],
      [null, "auditor-1"],
    ] as [number[] | null, string][]) {
      const harness = dbWith({ reads: [[{ id: 5, orgId: ORG }], []] });
      const { service: scope } = scopeOf(warehouses);
      await serviceWith(harness, scope, cache).findOne(ORG, user, 5);
    }

    expect(keys).toEqual(["detail:7:5", "detail:9:5", "detail:all:5"]);
    expect(new Set(keys).size).toBe(3);
  });

  it("builds exactly the predicate the list builds", async () => {
    // The drift guard, and the reason the predicate is one private method rather
    // than a second copy: the list gaining a scope its detail was never told
    // about is the whole defect.
    const { service: scope } = scopeOf([7, 9]);

    const list = dbWith();
    const { cache: listCache } = cacheWith();
    await serviceWith(list, scope, listCache).list(ORG, "picker-1", { page: 1, limit: 20 } as never);

    const detail = dbWith();
    const { cache: detailCache } = cacheWith();
    await expect(
      serviceWith(detail, scope, detailCache).findOne(ORG, "picker-1", 5),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sourceClause(detail.wheres[0] as SQL)).toBe(sourceClause(list.wheres[0] as SQL));
  });
});

describe("the mutations that take a load id", () => {
  it("refuses to dispatch one outside the caller's warehouses, before the idempotency claim", async () => {
    /*
     * Refusing on the entry read means the manifest is never read either — the
     * lines, and the shipment and transfer statuses behind them — and no key is
     * claimed, so a probe cannot burn one.
     */
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope, cache).dispatch(ORG, "nobody-1", 5, {} as never, "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    expect(harness.wheres).toHaveLength(1);
    expect(harness.transaction).not.toHaveBeenCalled();
    expect(harness.updates).toHaveLength(0);
  });

  it("refuses to close one outside the caller's warehouses, and writes nothing", async () => {
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope, cache).close(ORG, "nobody-1", 5, {} as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    expect(harness.updates).toHaveLength(0);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("refuses to cancel one outside the caller's warehouses, and writes nothing", async () => {
    // The UPDATE is the whole damage here; `rejects` alone would not see it.
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope, cache).cancel(ORG, "nobody-1", 5),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    expect(harness.updates).toHaveLength(0);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("lets an unrestricted caller straight through to the business rule", async () => {
    /*
     * These mutations write through `tx.update`, and the shared harness's
     * transaction handle offers no `update` on purpose, so a gate that failed to
     * refuse fails loudly rather than passing quietly. A ConflictException on
     * the status is therefore the pass-through proof: the warehouse gate was
     * passed and the command reached the rule that actually applies to it.
     */
    const harness = dbWith({ reads: [[{ id: 5, orgId: ORG, status: "DISPATCHED" }]] });
    const { cache } = cacheWith();
    const { service: scope, consulted } = scopeOf(null);

    await expect(
      serviceWith(harness, scope, cache).cancel(ORG, "auditor-1", 5),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(sqlText(harness.wheres[0] as SQL)).not.toContain("source_warehouse_id");
    expect(harness.updates).toHaveLength(0);
  });
});

describe("raising a load", () => {
  it("refuses a source warehouse the caller does not hold, and inserts nothing", async () => {
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      serviceWith(harness, scope, cache).create(ORG, "picker-1", {
        sourceWarehouseId: 9,
        shipmentIds: [],
        transferIds: [],
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Nothing written, and the number sequence never even burnt.
    expect(harness.inserts).toHaveLength(0);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("refuses a shipment pulled onto the load from a warehouse the caller does not hold", async () => {
    /*
     * The half nothing checked at all. The source warehouse here IS the
     * caller's, so the refusal can only be coming from the line gate — and the
     * shipment is measured by its OWN aggregate's rule, its warehouse column,
     * rather than by a rule invented for loads.
     */
    const harness = dbWith({ reads: [[]] });
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      serviceWith(harness, scope, cache).create(ORG, "picker-1", {
        sourceWarehouseId: 7,
        shipmentIds: [55],
        transferIds: [],
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain('"inv_shipments"."warehouse_id" IN');
    expect(harness.inserts).toHaveLength(0);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("refuses a transfer whose ends the caller does not hold, by the transfer's own both-ends rule", async () => {
    /*
     * A transfer is in scope only when BOTH of its ends are, which is how
     * `listTransfers` scopes one: seeing a single leg would expose the
     * counterpart warehouse's movement. Asserted on the compiled predicate,
     * because "it threw" is satisfied by an empty fixture either way.
     */
    const harness = dbWith({ reads: [[]] });
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      serviceWith(harness, scope, cache).create(ORG, "picker-1", {
        sourceWarehouseId: 7,
        shipmentIds: [],
        transferIds: [77],
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(harness.wheres[0] as SQL);
    expect(text).toContain('"inv_stock_transfers"."from_location_id" IN');
    expect(text).toContain('"inv_stock_transfers"."to_location_id" IN');
    expect(harness.inserts).toHaveLength(0);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("lets an unrestricted caller's load through both gates", async () => {
    /*
     * The pass-through, marked with a sentinel rather than a completed write:
     * `create` inserts through the transaction handle, which the shared harness
     * deliberately does not equip, so reaching the number sequence is the
     * furthest an assertion can follow it — and that is already past both gates.
     */
    const harness = dbWith({ reads: [[{ id: 55 }]] });
    const { cache } = cacheWith();
    const { service: scope, consulted } = scopeOf(null);
    const numSeq = { next: () => Promise.reject(new Error("reached the number sequence")) };

    await expect(
      serviceWith(harness, scope, cache, numSeq).create(ORG, "auditor-1", {
        sourceWarehouseId: 9,
        shipmentIds: [55],
        transferIds: [],
      } as never),
    ).rejects.toThrow(/reached the number sequence/);

    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(harness.inserts).toHaveLength(0);
  });
});
