import { NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { CustomerReturnsService } from "../customer-returns.service";
import { assertCustomerReturnWithinShipped } from "../returnable-quantity";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import type { CreateCustomerReturnInput } from "../dto/inv-returns.schemas";
import { cacheWith, dbWith, scopeOf, sqlText, type DbHarness } from "./warehouse-scope-harness";

/**
 * A return could be raised against another warehouse's order or shipment.
 *
 * `create` validated `so_id` and `shipment_id` against the ORG — "is this id
 * mine to name at all" — and never against the caller's warehouses. So a scoped
 * operator could anchor a DRAFT to a despatch out of a building they hold
 * nothing in. Nothing moved, because a DRAFT posts no stock, and every step
 * after it is gated, so the document went invisible to its own author the
 * moment it was saved: a write into somebody else's building, leaving an
 * orphaned draft behind.
 *
 * The quieter half is the measurement. `assertCustomerReturnWithinShipped` runs
 * next and reads that shipment's lines on the caller's behalf, and its refusal
 * names the quantity — so the unguarded create also answered "how much did you
 * send out of that building". Every refusal below asserts that helper was never
 * CALLED, which is the `createReservation` ordering rule: a caller who may not
 * see the document must not cause a query on its behalf.
 *
 * The rule is the list's rule, OR and not AND — visible through the order OR
 * the shipment — because a return this caller could SEE is a return they may
 * create, and `inv_sales_orders.warehouse_id` is nullable, so an order booked
 * before allocation carries none at all.
 */

jest.mock("../returnable-quantity", () => ({
  assertCustomerReturnWithinShipped: jest.fn(() => Promise.resolve()),
}));

const measured = jest.mocked(assertCustomerReturnWithinShipped);

const ORG = "org-1";
const SO_ID = 5;
const SHIPMENT_ID = 9;

/** The org-existence checks must ANSWER, or the gate behind them is never reached. */
const FOUND_IN_ORG = {
  invSalesOrders: { id: SO_ID },
  invShipments: { id: SHIPMENT_ID },
  invCustomerReturns: { id: 77, lines: [] },
} as const;

const INSERTED = [{ id: 77 }] as const;

function input(overrides: Partial<CreateCustomerReturnInput> = {}): CreateCustomerReturnInput {
  return {
    lines: [{ productVariantId: 11, quantity: "2.0000", reason: "arrived damaged" }],
    ...overrides,
  };
}

function serviceWith(harness: DbHarness, scope: WarehouseScopeService) {
  const { cache } = cacheWith();
  const numSeq = { next: jest.fn(() => Promise.resolve("CR-000001")) };
  const service = new CustomerReturnsService(
    harness.db,
    cache,
    {} as never,
    numSeq as never,
    scope,
  );
  return { service, numSeq };
}

/** Every predicate this statement set built over `table` that carries a scope test. */
function scopeQueriesOver(wheres: SQL[], table: string): string[] {
  return wheres
    .map((where) => sqlText(where))
    .filter((text) => text.includes(table) && text.includes("warehouse_id"));
}

/**
 * The `warehouse_id IN (…)` tests inside a compiled predicate, with the column
 * qualification and the placeholder NUMBERS normalised away.
 *
 * The list builds its arm inside a subquery, where the column is bare; the
 * create's gate names it on the table it is selecting from, where it is
 * qualified. Comparing raw text would fail on that alone and would say nothing
 * about whether the two attribute a return the same way, which is the question.
 */
function warehouseTests(text: string): string[] {
  return [...text.matchAll(/warehouse_id"? IN \([^)]*\)/g)].map((match) =>
    match[0].replace(/"/g, "").replace(/\$\d+/g, "$?"),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("raising a customer return against a sales order", () => {
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
      serviceWith(harness, scope).service.create(ORG, "nobody-1", input({ soId: SO_ID })),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[1] as SQL)).toContain("and FALSE");
    expect(harness.inserts).toHaveLength(0);
    expect(measured).not.toHaveBeenCalled();
  });

  it("narrows a scoped caller to the warehouses they hold, with no escape for a null one", async () => {
    /*
     * The NULL rule is not restated anywhere, it falls out of this expression:
     * `NULL IN (…)` is NULL, so an order attributed to no warehouse anchors the
     * return to none of the caller's — exactly as it is excluded from their
     * list. Hence the absence of any `IS NULL` escape is asserted rather than
     * merely left out.
     */
    const harness = dbWith({ rows: FOUND_IN_ORG, inserted: INSERTED });
    const { service: scope } = scopeOf([7, 9]);

    await expect(
      serviceWith(harness, scope).service.create(ORG, "picker-1", input({ soId: SO_ID })),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(harness.wheres[1] as SQL)).toBe(
      '("inv_sales_orders"."id" = $1 and "inv_sales_orders"."org_id" = $2 ' +
        'and "inv_sales_orders"."warehouse_id" IN ($3, $4))',
    );
    expect(sqlText(harness.wheres[1] as SQL)).not.toContain("IS NULL");
    expect(harness.inserts).toHaveLength(0);
    expect(measured).not.toHaveBeenCalled();
  });

  it("lets one through when the order sits in a warehouse the caller holds", async () => {
    // The other direction, and the reason the assertions above are not vacuous:
    // the same fixture shape with the gate SATISFIED writes both rows.
    const harness = dbWith({
      rows: FOUND_IN_ORG,
      reads: [[{ id: SO_ID }]],
      inserted: INSERTED,
    });
    const { service: scope } = scopeOf([7]);
    const { service, numSeq } = serviceWith(harness, scope);

    await service.create(ORG, "picker-1", input({ soId: SO_ID }));

    expect(measured).toHaveBeenCalledTimes(1);
    expect(numSeq.next).toHaveBeenCalledTimes(1);
    expect(harness.inserts).toHaveLength(2);
  });
});

describe("the order and the shipment are two spellings of one anchor", () => {
  it("accepts a shipment in scope even when the order beside it is not", async () => {
    /*
     * OR, not AND, and this is the case that decides it. `warehouse_id` on a
     * sales order is nullable and an order booked before it was allocated
     * carries none, so asking of each document independently would refuse the
     * operator who then shipped it out of their own building — a return the
     * list would have shown them.
     */
    const harness = dbWith({
      rows: FOUND_IN_ORG,
      reads: [[], [{ id: SHIPMENT_ID }]],
      inserted: INSERTED,
    });
    const { service: scope } = scopeOf([7]);

    await serviceWith(harness, scope).service.create(
      ORG,
      "picker-1",
      input({ soId: SO_ID, shipmentId: SHIPMENT_ID }),
    );

    expect(scopeQueriesOver(harness.wheres, "inv_sales_orders")).toHaveLength(1);
    expect(scopeQueriesOver(harness.wheres, "inv_shipments")).toHaveLength(1);
    expect(harness.inserts).toHaveLength(2);
  });

  it("refuses only when neither document is in scope, having asked about both", async () => {
    const harness = dbWith({ rows: FOUND_IN_ORG, reads: [[], []], inserted: INSERTED });
    const { service: scope } = scopeOf([7]);

    await expect(
      serviceWith(harness, scope).service.create(
        ORG,
        "picker-1",
        input({ soId: SO_ID, shipmentId: SHIPMENT_ID }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(scopeQueriesOver(harness.wheres, "inv_sales_orders")).toHaveLength(1);
    expect(scopeQueriesOver(harness.wheres, "inv_shipments")).toHaveLength(1);
    expect(harness.inserts).toHaveLength(0);
    expect(measured).not.toHaveBeenCalled();
  });

  it("stops at the first document that answers, and never asks about the second", async () => {
    // Not cosmetic: an anchor that is already satisfied is not a licence to run
    // a second query about a document the caller may not be entitled to.
    const harness = dbWith({
      rows: FOUND_IN_ORG,
      reads: [[{ id: SO_ID }]],
      inserted: INSERTED,
    });
    const { service: scope } = scopeOf([7]);

    await serviceWith(harness, scope).service.create(
      ORG,
      "picker-1",
      input({ soId: SO_ID, shipmentId: SHIPMENT_ID }),
    );

    expect(scopeQueriesOver(harness.wheres, "inv_sales_orders")).toHaveLength(1);
    expect(scopeQueriesOver(harness.wheres, "inv_shipments")).toHaveLength(0);
  });
});

describe("the callers the gate deliberately does not narrow", () => {
  it("consults the scope for an org-wide caller, and then asks nothing further", async () => {
    // "No predicate" cannot on its own tell an UNRESTRICTED caller from an
    // UNGATED method — which is the defect — so the absence is asserted
    // alongside proof that the scope was resolved at all.
    const harness = dbWith({ rows: FOUND_IN_ORG, inserted: INSERTED });
    const { service: scope, consulted } = scopeOf(null);

    await serviceWith(harness, scope).service.create(
      ORG,
      "auditor-1",
      input({ soId: SO_ID, shipmentId: SHIPMENT_ID }),
    );

    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(scopeQueriesOver(harness.wheres, "inv_sales_orders")).toHaveLength(0);
    expect(scopeQueriesOver(harness.wheres, "inv_shipments")).toHaveLength(0);
    expect(harness.inserts).toHaveLength(2);
  });

  it("leaves a walk-in return citing no document alone, without resolving a scope at all", async () => {
    /*
     * The deliberate hole, pinned so it is a decision rather than a gap.
     * `assertCustomerReturnWithinShipped` makes the same exception for the same
     * reason: there is nothing to measure it against and nothing to attribute
     * it to either. The consequence is real and stays — a return anchored to no
     * document is invisible to every scoped operator INCLUDING the one who just
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
  it("tests the same warehouse column against the same scope as the list arm", async () => {
    /*
     * The drift guard, and the reason it is worth one. This module's original
     * defect was a list that gained a scope while the reads and writes beside
     * it were never told; a create that attributes through a different column,
     * or a different id set, would let somebody raise a return they then cannot
     * see. Both sides are normalised for qualification and placeholder number,
     * because the list builds its arm inside a subquery where the column is
     * bare and the create names it on the table it selects from.
     */
    const { service: scope } = scopeOf([7, 9]);

    const list = dbWith();
    const { service: lister } = serviceWith(list, scope);
    await lister.list(ORG, "picker-1", { page: 1, limit: 20 } as never);

    const create = dbWith({ rows: FOUND_IN_ORG, reads: [[], []], inserted: INSERTED });
    await expect(
      serviceWith(create, scope).service.create(
        ORG,
        "picker-1",
        input({ soId: SO_ID, shipmentId: SHIPMENT_ID }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    const fromList = warehouseTests(sqlText(list.wheres[0] as SQL));
    const fromCreate = [
      ...warehouseTests(scopeQueriesOver(create.wheres, "inv_sales_orders")[0] ?? ""),
      ...warehouseTests(scopeQueriesOver(create.wheres, "inv_shipments")[0] ?? ""),
    ];

    expect(fromList).toEqual(["warehouse_id IN ($?, $?)", "warehouse_id IN ($?, $?)"]);
    expect(fromCreate).toEqual(fromList);
  });
});
