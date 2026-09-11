import { NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { VendorReturnsService } from "../vendor-returns.service";
import { assertVendorReturnWithinReceived } from "../returnable-quantity";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import type { CreateVendorReturnInput } from "../dto/inv-returns.schemas";
import { cacheWith, dbWith, scopeOf, sqlText, type DbHarness } from "../../__tests__/warehouse-scope-harness";

/**
 * An RMA could be raised against a receipt taken into another warehouse.
 *
 * `create` validated `grn_id` against the ORG — "is this id mine to name at
 * all" — and never against the caller's warehouses. So a scoped operator could
 * anchor a DRAFT to goods booked into a building they hold nothing in. Nothing
 * moved, because a DRAFT posts no stock, and every step after it is gated, so
 * the document went invisible to its own author the moment it was saved.
 *
 * The quieter half is the measurement. `assertVendorReturnWithinReceived` runs
 * next and reads that GRN's lines on the caller's behalf, and its refusal names
 * the quantity — so the unguarded create also answered "how much did that
 * building take in". Every refusal below asserts that helper was never CALLED.
 *
 * Attributed through the GRN's LOCATION, which is a different predicate from
 * the customer half's `scope.warehouse`: a receipt names the bin the goods
 * landed in, not the building. Each aggregate follows its own rule rather than
 * a house default, and the shapes below are asserted so they cannot converge by
 * accident.
 */

jest.mock("../returnable-quantity", () => ({
  assertVendorReturnWithinReceived: jest.fn(() => Promise.resolve()),
}));

const measured = jest.mocked(assertVendorReturnWithinReceived);

const ORG = "org-1";
const VENDOR_ID = 3;
const PO_ID = 4;
const GRN_ID = 8;

/** The org-existence checks must ANSWER, or the gate behind them is never reached. */
const FOUND_IN_ORG = {
  invVendors: { id: VENDOR_ID },
  invPurchaseOrders: { id: PO_ID },
  invGrns: { id: GRN_ID },
  invVendorReturns: { id: 77, lines: [] },
} as const;

const INSERTED = [{ id: 77 }] as const;

function input(overrides: Partial<CreateVendorReturnInput> = {}): CreateVendorReturnInput {
  return {
    vendorId: VENDOR_ID,
    lines: [{ productVariantId: 11, quantity: "2.0000", reason: "DAMAGED" }],
    ...overrides,
  };
}

function serviceWith(harness: DbHarness, scope: WarehouseScopeService) {
  const { cache } = cacheWith();
  const numSeq = { next: jest.fn(() => Promise.resolve("VR-000001")) };
  const service = new VendorReturnsService(
    harness.db,
    cache,
    {} as never,
    numSeq as never,
    scope,
    { post: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, numSeq };
}

/** Every predicate this statement set built over `table` that carries a scope test. */
function scopeQueriesOver(wheres: SQL[], table: string): string[] {
  return wheres
    .map((where) => sqlText(where))
    .filter((text) => text.includes(table) && text.includes("warehouse_id"));
}

/** A compiled predicate with its placeholder NUMBERS and line breaks normalised away. */
function shape(text: string): string {
  return text.replace(/\$\d+/g, "$?").replace(/\s+/g, " ");
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("raising a vendor return against a goods receipt", () => {
  it("refuses one out of the caller's warehouses, before measuring and before writing", async () => {
    /*
     * The PREDICATE is the assertion, not the throw. The gate's fixture answers
     * with no row whichever way the service is written, so `rejects` alone would
     * pass against the unguarded code it was written to reject. An empty scope
     * compiles to `… and FALSE`, and that is what a database acts on.
     *
     * `inserts` proves the write was never REACHED rather than merely undone —
     * a service that inserted the header and refused afterwards would still have
     * written it, and `create` opens no transaction to roll one back.
     */
    const harness = dbWith({ rows: FOUND_IN_ORG, inserted: INSERTED });
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope).service.create(ORG, "nobody-1", input({ grnId: GRN_ID })),
    ).rejects.toBeInstanceOf(NotFoundException);

    // wheres: [0] the vendor org check, [1] the GRN org check, [2] this gate.
    expect(sqlText(harness.wheres[2] as SQL)).toContain("and FALSE");
    expect(harness.inserts).toHaveLength(0);
    expect(measured).not.toHaveBeenCalled();
  });

  it("narrows a scoped caller through the receipt's LOCATION, with no escape for a null one", async () => {
    /*
     * `scope.location`, not `scope.warehouse`. The NULL rule falls out of the
     * same expression rather than being restated: `NULL IN (…)` is NULL, so a
     * receipt with no location anchors the return to none of the caller's
     * warehouses — exactly as it is excluded from their list. Hence the absence
     * of any `IS NULL` escape is asserted rather than merely left out.
     */
    const harness = dbWith({ rows: FOUND_IN_ORG, inserted: INSERTED });
    const { service: scope } = scopeOf([7, 9]);

    await expect(
      serviceWith(harness, scope).service.create(ORG, "picker-1", input({ grnId: GRN_ID })),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(shape(sqlText(harness.wheres[2] as SQL))).toBe(
      '("inv_grns"."id" = $? and "inv_grns"."org_id" = $? ' +
        'and "inv_grns"."location_id" IN ( SELECT id FROM inv_locations ' +
        "WHERE warehouse_id IN ($?, $?) ))",
    );
    expect(sqlText(harness.wheres[2] as SQL)).not.toContain("IS NULL");
    expect(harness.inserts).toHaveLength(0);
    expect(measured).not.toHaveBeenCalled();
  });

  it("lets one through when the receipt landed in a warehouse the caller holds", async () => {
    // The other direction, and the reason the assertions above are not vacuous:
    // the same fixture shape with the gate SATISFIED writes both rows.
    const harness = dbWith({
      rows: FOUND_IN_ORG,
      reads: [[{ id: GRN_ID }]],
      inserted: INSERTED,
    });
    const { service: scope } = scopeOf([7]);
    const { service, numSeq } = serviceWith(harness, scope);

    await service.create(ORG, "picker-1", input({ grnId: GRN_ID }));

    expect(measured).toHaveBeenCalledTimes(1);
    expect(numSeq.next).toHaveBeenCalledTimes(1);
    expect(harness.inserts).toHaveLength(2);
  });
});

describe("the documents the gate deliberately does not ask about", () => {
  it("never asks about the purchase order, only the receipt", async () => {
    /*
     * The transfer's source/destination asymmetry, in this shape. A PO carries
     * its own nullable `warehouse_id`, so asserting it would be possible — and
     * wrong twice over. It is stricter than the list, which attributes a vendor
     * return through the GRN and through nothing else; and a PO is raised
     * centrally against a delivery warehouse that a receiving variance can move,
     * so it would refuse the operator sending back goods they actually took in.
     *
     * If that is wrong it is wrong as a DECISION: this fails if a later change
     * starts asserting the PO, so tightening it has to be deliberate rather
     * than drifted into.
     */
    const harness = dbWith({
      rows: FOUND_IN_ORG,
      reads: [[{ id: GRN_ID }]],
      inserted: INSERTED,
    });
    const { service: scope } = scopeOf([7]);

    await serviceWith(harness, scope).service.create(
      ORG,
      "picker-1",
      input({ poId: PO_ID, grnId: GRN_ID }),
    );

    expect(scopeQueriesOver(harness.wheres, "inv_purchase_orders")).toHaveLength(0);
    expect(scopeQueriesOver(harness.wheres, "inv_grns")).toHaveLength(1);
    expect(harness.inserts).toHaveLength(2);
  });

  it("consults the scope for an org-wide caller, and then asks nothing further", async () => {
    // "No predicate" cannot on its own tell an UNRESTRICTED caller from an
    // UNGATED method — which is the defect — so the absence is asserted
    // alongside proof that the scope was resolved at all.
    const harness = dbWith({ rows: FOUND_IN_ORG, inserted: INSERTED });
    const { service: scope, consulted } = scopeOf(null);

    await serviceWith(harness, scope).service.create(ORG, "auditor-1", input({ grnId: GRN_ID }));

    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(scopeQueriesOver(harness.wheres, "inv_grns")).toHaveLength(0);
    expect(harness.inserts).toHaveLength(2);
  });

  it("leaves an RMA citing no receipt alone, without resolving a scope at all", async () => {
    /*
     * The deliberate hole, pinned so it is a decision rather than a gap.
     * `assertVendorReturnWithinReceived` makes the same exception for the same
     * reason: there is nothing to measure it against and nothing to attribute
     * it to either. The consequence is real and stays — an RMA anchored to no
     * receipt is invisible to every scoped operator INCLUDING the one who just
     * raised it, which is why `create` still ends on the unscoped read.
     */
    const harness = dbWith({ rows: FOUND_IN_ORG, inserted: INSERTED });
    const { service: scope, consulted } = scopeOf([]);

    await serviceWith(harness, scope).service.create(ORG, "nobody-1", input());

    expect(consulted).not.toHaveBeenCalled();
    expect(harness.inserts).toHaveLength(2);
  });
});

describe("the gate and the list attribute a return the same way", () => {
  it("builds the list's own location test, and not the customer half's warehouse test", async () => {
    /*
     * The drift guard. This module's original defect was a list that gained a
     * scope while the reads and writes beside it were never told; a create that
     * attributes through a different column would let somebody raise an RMA
     * they then cannot see. The customer half tests `warehouse_id` on the
     * document directly, this one resolves a location first, and asserting both
     * halves of that keeps the two from converging on a house default.
     */
    const { service: scope } = scopeOf([7]);

    const list = dbWith();
    const { service: lister } = serviceWith(list, scope);
    await lister.list(ORG, "picker-1", { page: 1, limit: 20 } as never);

    const create = dbWith({ rows: FOUND_IN_ORG, reads: [[]], inserted: INSERTED });
    await expect(
      serviceWith(create, scope).service.create(ORG, "picker-1", input({ grnId: GRN_ID })),
    ).rejects.toBeInstanceOf(NotFoundException);

    const fromList = shape(sqlText(list.wheres[0] as SQL));
    const fromCreate = shape(scopeQueriesOver(create.wheres, "inv_grns")[0] ?? "");

    const locationTest = "IN ( SELECT id FROM inv_locations WHERE warehouse_id IN ($?) )";
    expect(fromList).toContain(`location_id ${locationTest}`);
    expect(fromCreate).toContain(`"inv_grns"."location_id" ${locationTest}`);
    expect(fromCreate).not.toContain('"inv_grns"."warehouse_id"');
  });
});
