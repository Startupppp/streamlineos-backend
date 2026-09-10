import { NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { InvStockTransfersService } from "../inv-stock-transfers.service";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import {
  dbWith,
  scopeClause,
  scopeOf,
  sqlText,
  type DbHarness,
} from "../../__tests__/warehouse-scope-harness";

/**
 * `listTransfers` was scoped and everything you could do to one transfer by id
 * was not.
 *
 * The list has narrowed on BOTH ends since the warehouse work landed — a
 * transfer is one document about two buildings, and seeing a single leg exposes
 * the counterpart warehouse's movement. `getTransfer` took no `userId` at all,
 * because the controller had `@CurrentUser()` in hand and passed only `orgId`,
 * so a transfer an operator could not see in their list was theirs to read
 * whole: both bins, both buildings, every line with its lot and its serial.
 *
 * The four commands had `userId` and spent it only on authorship and audit, and
 * each reached the row on `org_id` and the id alone. Two of them are not caught
 * by anything downstream, and that is the part worth stating:
 *
 *  - `reserveTransfer` posts NO movements. A reservation is a soft hold, so
 *    `ReservationService` never reaches the stock engine and
 *    `assertLocationsInScope` never runs. A stranger could therefore take
 *    another building's stock out of its available pool — the goods sit on the
 *    shelf and stop being sellable, with no document there to explain it.
 *  - `cancelTransfer` posts no movements either, by design: it stops at
 *    RESERVED, so there is never anything in transit to unwind. A stranger
 *    could release the reservations and flip the document terminal outright.
 *
 * `dispatchTransfer` and `completeTransfer` DO post, so the stock itself was
 * never at risk — the engine would have refused the movement. What was at risk
 * is the document: the status was read and reported before the engine was ever
 * reached, and dispatch resolves (and can create) a transit bin in the source
 * building on the way.
 *
 * The commands deliberately do NOT take the list's both-ends predicate, and the
 * reason is `createTransfer`'s own documented rule: the source is asserted on
 * create and the destination is not, because an operator sending stock to
 * another building routinely holds no part of it. Gating the commands on both
 * ends would refuse the very operator that rule exists to allow.
 */

const ORG = "org-1";
const LIST_QUERY = { page: 1, limit: 20 } as never;

function serviceWith(harness: DbHarness, scope: WarehouseScopeService) {
  const stub = {} as never;
  return new InvStockTransfersService(
    harness.db,
    { invalidate: () => Promise.resolve(), invalidateNamespace: () => Promise.resolve() } as never,
    stub,
    stub,
    stub,
    scope,
    stub,
  );
}

describe("one stock transfer, read by id", () => {
  it("is unreachable for a caller holding no warehouse, and answers not found", async () => {
    /*
     * The PREDICATE is the assertion, not the throw. The fixture answers with no
     * row whichever way the service is written, so `rejects` alone would pass
     * against the unscoped code it was written to reject. An empty scope
     * compiles both ends to FALSE, and that is what a database acts on.
     *
     * 404 rather than 403 is load-bearing (§4): a "forbidden" on a transfer id
     * confirms the transfer exists.
     */
    const harness = dbWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope).getTransfer(ORG, "nobody-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    // One read, not two. A gate that threw AFTER loading the header would still
    // satisfy `rejects` while having put both bins and every line on the wire.
    expect(harness.wheres).toHaveLength(1);
  });

  it("narrows a scoped caller to both ends, with no IS NULL escape", async () => {
    /*
     * BOTH halves are asserted because either one alone is the defect: a gate on
     * the source only would still hand over the destination building's bin.
     *
     * The NULL rule is asserted rather than merely left out, because it differs
     * by table on purpose. `location_id IN (SELECT …)` is NULL for an end
     * attributed to no location, so such a transfer stays invisible to a scoped
     * operator — which is exactly what the list has always done. The handling
     * unit goes the other way and keeps an `IS NULL` escape, because a unit
     * nested inside another genuinely has no location of its own.
     */
    const harness = dbWith();
    const { service: scope } = scopeOf([7, 9]);

    await expect(
      serviceWith(harness, scope).getTransfer(ORG, "picker-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(harness.wheres[0] as SQL);
    expect(text).toContain('"inv_stock_transfers"."from_location_id" IN (');
    expect(text).toContain('"inv_stock_transfers"."to_location_id" IN (');
    expect(text).not.toContain("IS NULL");
  });

  it("consults the scope even for an org-wide reader, and then narrows nothing", async () => {
    // "No location predicate" cannot on its own tell an UNRESTRICTED reader from
    // an UNSCOPED method — which is the defect — so the absence is asserted
    // alongside proof that the scope was resolved at all.
    const harness = dbWith({ rows: { invStockTransfers: { id: 42, orgId: ORG } } });
    const { service: scope, consulted } = scopeOf(null);

    const detail = await serviceWith(harness, scope).getTransfer(ORG, "auditor-1", 42);

    expect(detail?.id).toBe(42);
    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(sqlText(harness.wheres[0] as SQL)).not.toContain("location_id IN (");
  });

  it("builds exactly the predicate the list builds", async () => {
    /*
     * The drift guard, and the reason the predicate lives in one private method
     * composed of two named halves rather than a second copy. Two hand-copied
     * predicates agreeing today is not the same as them being one predicate:
     * this list gained its scope and the detail beside it was simply never told,
     * which is the whole defect.
     */
    const { service: scope } = scopeOf([7, 9]);

    const list = dbWith();
    await serviceWith(list, scope).listTransfers(ORG, LIST_QUERY, "all", "picker-1");

    const detail = dbWith();
    await expect(
      serviceWith(detail, scope).getTransfer(ORG, "picker-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    const clause = scopeClause(sqlText(detail.wheres[0] as SQL), "inv_stock_transfers");
    expect(clause).not.toBe("");
    expect(clause).toBe(scopeClause(sqlText(list.wheres[0] as SQL), "inv_stock_transfers"));
  });
});

describe("the commands that take a transfer id", () => {
  it("refuses to reserve one outside the caller's warehouses, and holds nothing", async () => {
    /*
     * The sharpest of the four, because nothing downstream would have caught it.
     * A reservation posts no movement, so the stock engine is not on this path
     * at all: the hold would simply have been taken against another building's
     * available stock.
     *
     * The gate sits on the entry read, so the attempt never reaches the
     * idempotency claim and cannot burn a key either.
     */
    const harness = dbWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope).reserveTransfer(ORG, "nobody-1", 42, "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    // `rejects` alone would not see this: a service that reserved and then threw
    // satisfies it just as well.
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("refuses to cancel one outside the caller's warehouses, and releases nothing", async () => {
    const harness = dbWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope).cancelTransfer(ORG, "nobody-1", 42, "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    expect(harness.transaction).not.toHaveBeenCalled();
    expect(harness.updates).toHaveLength(0);
  });

  it("refuses to dispatch one outside the caller's warehouses, before the status is read", async () => {
    /*
     * The engine would have refused the movement a moment later, so this is not
     * about the stock. It is about what the caller learns and what gets created
     * on the way: the header read reports the document's status, and the
     * transit-location resolve can CREATE a bin in a building the caller holds
     * nothing in. Refusing on the entry read means neither happens.
     */
    const harness = dbWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope).dispatchTransfer(ORG, "nobody-1", 42, "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(harness.transaction).not.toHaveBeenCalled();
    /*
     * The gate's OWN read, identified by its predicate rather than by counting.
     * `dispatchTransfer` fetches the header first thing, so a bare count of one
     * read passes against the ungated code too — measured, by removing the gate
     * and watching this case survive. An empty scope compiles the source end to
     * FALSE, which the header read has no reason to contain.
     */
    expect(sqlText(harness.wheres[0] as SQL)).toContain("FALSE");
    // And exactly one: the header was never fetched, so its status was never in
    // a position to be described back.
    expect(harness.wheres).toHaveLength(1);
  });

  it("asks the SOURCE end for reserve, dispatch and cancel", async () => {
    /*
     * Not the list's pair, and that is the point. `createTransfer` asserts the
     * source and deliberately not the destination, because an operator sending
     * stock to another building routinely holds no part of it — so a both-ends
     * gate here would refuse the operator that rule exists to allow, on a
     * transfer they were entitled to raise.
     */
    const { service: scope } = scopeOf([7]);

    for (const run of [
      (s: InvStockTransfersService) => s.reserveTransfer(ORG, "picker-1", 42, "key-1"),
      (s: InvStockTransfersService) => s.dispatchTransfer(ORG, "picker-1", 42, "key-1"),
      (s: InvStockTransfersService) => s.cancelTransfer(ORG, "picker-1", 42, "key-1"),
    ]) {
      const harness = dbWith();
      await expect(run(serviceWith(harness, scope))).rejects.toBeInstanceOf(NotFoundException);

      const text = sqlText(harness.wheres[0] as SQL);
      expect(text).toContain('"inv_stock_transfers"."from_location_id" IN (');
      expect(text).not.toContain('"inv_stock_transfers"."to_location_id" IN (');
    }
  });

  it("asks the DESTINATION end for complete, because completing is a receipt", async () => {
    /*
     * The other end, for the one command that puts goods somewhere rather than
     * taking them out. It is also the end the engine will assert on the arrival
     * movement, so this refuses nothing the engine would have allowed — it
     * refuses it before the status, and a short receipt, can be described back
     * to somebody who cannot see the document.
     */
    const harness = dbWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      serviceWith(harness, scope).completeTransfer(ORG, "picker-1", 42, { lines: [] } as never, "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(harness.wheres[0] as SQL);
    expect(text).toContain('"inv_stock_transfers"."to_location_id" IN (');
    expect(text).not.toContain('"inv_stock_transfers"."from_location_id" IN (');
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("lets an unrestricted caller straight through to the work behind the gate", async () => {
    /*
     * The pass-through case. Asserted through the machinery BEHIND the gate
     * rather than through a completed cancel: the shared harness's transaction
     * handle deliberately offers no `insert`, so the idempotency claim explodes
     * — which is exactly the proof wanted here, that the command reached it.
     */
    const harness = dbWith({ rows: { invStockTransfers: { id: 42, orgId: ORG } } });
    const { service: scope, consulted } = scopeOf(null);

    await expect(
      serviceWith(harness, scope).cancelTransfer(ORG, "auditor-1", 42, "key-1"),
    ).rejects.not.toBeInstanceOf(NotFoundException);

    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(harness.transaction).toHaveBeenCalled();
  });
});
