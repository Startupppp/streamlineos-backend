import { ConflictException, NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { ShipmentsService } from "../shipments.service";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import {
  cacheWith,
  dbWith,
  scopeOf,
  sqlText,
  type DbHarness,
} from "../../__tests__/warehouse-scope-harness";

/**
 * `list` was scoped and everything you could do to one shipment by id was not.
 *
 * The list resolves the caller's warehouses and narrows on `warehouse_id`.
 * `findOne` took no `userId` at all — the controller had `@CurrentUser()` in
 * hand and passed only `orgId` — so a despatch an operator could not see in
 * their list was theirs to read whole: every line, every package, the carrier
 * and the tracking number.
 *
 * `update`, `ship` and `cancel` had `userId` and spent it only on authorship
 * columns, and each reached the row on `org_id` and the id alone. Nothing
 * downstream catches it, because none of these three posts stock: a shipment
 * header is a document, so the stock engine's `assertLocationsInScope` — the
 * check that made the equivalent adjustment hole survivable — never runs on this
 * path at all. `ship` is the sharpest of the three: it flips the row to SHIPPED
 * and emits `inventory.shipment.dispatched`, so a caller could dispatch another
 * building's goods to its carrier.
 *
 * `update` carries a second door. `updateShipmentSchema` has a `warehouseId`
 * field, so even with the read gated a caller could take a shipment they CAN see
 * and re-home it into a building they cannot — bypassing the create-side assert
 * that has guarded `warehouseId` since the warehouse work landed.
 */

const ORG = "org-1";

function serviceWith(harness: DbHarness, scope: WarehouseScopeService, cache: unknown) {
  return new ShipmentsService(
    harness.db,
    cache as never,
    { next: () => Promise.resolve("SHP-0001") } as never,
    { insert: () => Promise.resolve(undefined) } as never,
    { get: () => Promise.resolve({ packageRequiredForShipping: false }) } as never,
    scope,
  );
}

/**
 * The scope-bearing tail of a compiled predicate, with placeholder NUMBERS
 * normalised away — a detail read binds the shipment id first, so every `$n`
 * inside its scope clause is shifted relative to the list's.
 */
function warehouseClause(statement: SQL): string {
  const text = sqlText(statement).replace(/\$\d+/g, "$?");
  const at = text.indexOf('"inv_shipments"."warehouse_id"');
  expect(at).toBeGreaterThanOrEqual(0);
  return text.slice(at);
}

describe("one shipment, read by id", () => {
  it("is unreachable for a caller holding no warehouse, and answers not found", async () => {
    /*
     * The PREDICATE is the assertion, not the throw. The fixture answers with no
     * row whichever way the service is written, so `rejects` alone would pass
     * against the unscoped code it was written to reject. An empty scope
     * compiles to `… AND FALSE`, and that is what a database acts on.
     *
     * 404 rather than 403 is load-bearing (§4): "forbidden" on a shipment id is
     * an existence oracle.
     */
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope, cache).findOne(ORG, "nobody-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    /*
     * One read, not three. A gate that threw AFTER loading the header would
     * still satisfy `rejects` while having put the lines and the packages on
     * the wire.
     */
    expect(harness.wheres).toHaveLength(1);
  });

  it("narrows a scoped caller to their own warehouses, with no IS NULL escape", async () => {
    /*
     * The NULL rule differs by table on purpose and is asserted rather than
     * merely left out: `NULL IN (…)` is NULL, so a shipment attributed to no
     * warehouse stays invisible to a scoped operator — which is precisely what
     * the list has always done. The ASN header goes the other way, keeping an
     * `IS NULL` escape because its warehouse may not be known yet.
     */
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7, 9]);

    await expect(
      serviceWith(harness, scope, cache).findOne(ORG, "picker-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(warehouseClause(harness.wheres[0] as SQL)).toContain(
      '"inv_shipments"."warehouse_id" IN ($?, $?)',
    );
    expect(sqlText(harness.wheres[0] as SQL)).not.toContain("IS NULL");
  });

  it("consults the scope even for an org-wide reader, and then narrows nothing", async () => {
    // "No warehouse predicate" cannot on its own tell an UNRESTRICTED reader
    // from an UNSCOPED method — which is the defect — so the absence is asserted
    // alongside proof that the scope was resolved at all.
    const harness = dbWith({ reads: [[{ id: 42, orgId: ORG }], [], []] });
    const { cache } = cacheWith();
    const { service: scope, consulted } = scopeOf(null);

    const detail = await serviceWith(harness, scope, cache).findOne(ORG, "auditor-1", 42);

    expect(detail.id).toBe(42);
    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(sqlText(harness.wheres[0] as SQL)).not.toContain("warehouse_id");
  });

  it("keys the cached detail by the scope, so one caller's answer is not served to the next", async () => {
    /*
     * §6, and the trap this fix walks into if it is half done. A perfect WHERE
     * clause under the old `detail:<id>` key would store the picker's narrowed
     * answer and hand it straight to the auditor, and the auditor's full row
     * back to the picker — leaving the read WORSE than the unscoped one it
     * replaces. Asserting on the KEYS is the only way to see that: every other
     * case in this file passes with the old key.
     */
    const { cache, keys } = cacheWith();

    for (const [warehouses, user] of [
      [[7], "picker-1"],
      [[9], "other-picker-1"],
      [null, "auditor-1"],
    ] as [number[] | null, string][]) {
      const harness = dbWith({ reads: [[{ id: 42, orgId: ORG }], [], []] });
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
     * the detail beside it was simply never told, which is the whole defect.
     */
    const { service: scope } = scopeOf([7, 9]);

    const list = dbWith();
    const { cache: listCache } = cacheWith();
    await serviceWith(list, scope, listCache).list(ORG, "picker-1", { page: 1, limit: 20 } as never);

    const detail = dbWith();
    const { cache: detailCache } = cacheWith();
    await expect(
      serviceWith(detail, scope, detailCache).findOne(ORG, "picker-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(warehouseClause(detail.wheres[0] as SQL)).toBe(
      warehouseClause(list.wheres[0] as SQL),
    );
  });
});

describe("the mutations that take a shipment id", () => {
  it("refuses to update one outside the caller's warehouses, and writes nothing", async () => {
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope, cache).update(ORG, "nobody-1", 42, { notes: "mine now" }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    // The UPDATE is the whole damage; `rejects` alone would not see it, because
    // a service that wrote and then threw satisfies it just as well.
    expect(harness.updates).toHaveLength(0);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("refuses to re-home a shipment it CAN see into a warehouse it cannot", async () => {
    /*
     * The second door, and the one a gate on the read alone leaves open.
     * `updateShipmentSchema` carries `warehouseId`, so a caller could take a
     * shipment in their own building and PATCH it into somebody else's —
     * bypassing the create-side assert entirely. The header read here SUCCEEDS,
     * so the refusal can only be coming from the destination check.
     */
    const harness = dbWith({ reads: [[{ id: 42, orgId: ORG, status: "DRAFT" }]] });
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      serviceWith(harness, scope, cache).update(ORG, "picker-1", 42, { warehouseId: 9 }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(harness.updates).toHaveLength(0);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("lets a re-home into a warehouse it does hold reach the write", async () => {
    // The counterpart, so the refusal above is proved to be about the SCOPE
    // rather than about the field being present at all.
    const harness = dbWith({ reads: [[{ id: 42, orgId: ORG, status: "DRAFT" }]] });
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);

    // The harness's transaction handle offers no `update`, so the write itself
    // explodes — which is exactly the proof wanted here: the gate let it get
    // that far.
    await expect(
      serviceWith(harness, scope, cache).update(ORG, "picker-1", 42, { warehouseId: 7 }),
    ).rejects.not.toBeInstanceOf(NotFoundException);
    expect(harness.transaction).toHaveBeenCalled();
  });

  it("refuses to ship one outside the caller's warehouses, before the idempotency claim", async () => {
    /*
     * Nothing downstream would have caught this. Shipping posts no movements, so
     * the stock engine never sees it; the row flips to SHIPPED and
     * `inventory.shipment.dispatched` goes out to the carrier for goods in a
     * building the caller has never worked in. Refusing on the entry read means
     * the claim is never taken either, so a probe cannot burn a key.
     */
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope, cache).ship(ORG, "nobody-1", 42, {}, "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    expect(harness.transaction).not.toHaveBeenCalled();
    expect(harness.updates).toHaveLength(0);
  });

  it("refuses to cancel one outside the caller's warehouses, and writes nothing", async () => {
    const harness = dbWith();
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope, cache).cancel(ORG, "nobody-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    expect(harness.updates).toHaveLength(0);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("lets an unrestricted caller straight through to the business rule", async () => {
    /*
     * The pass-through case, asserted through a rule BEHIND the gate rather than
     * through a completed write: these three mutations write via `tx.update`,
     * and the shared harness's transaction handle deliberately offers no
     * `update` so that a gate which failed to refuse fails loudly. A
     * ConflictException on the status is proof the warehouse gate was passed and
     * the command reached the rule that actually applies to it.
     */
    const harness = dbWith({ reads: [[{ id: 42, orgId: ORG, status: "SHIPPED" }]] });
    const { cache } = cacheWith();
    const { service: scope, consulted } = scopeOf(null);

    await expect(
      serviceWith(harness, scope, cache).cancel(ORG, "auditor-1", 42),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(sqlText(harness.wheres[0] as SQL)).not.toContain("warehouse_id");
    expect(harness.updates).toHaveLength(0);
  });
});
