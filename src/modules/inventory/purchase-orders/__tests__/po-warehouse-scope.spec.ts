import { NotFoundException } from "@nestjs/common";
import { PoService } from "../po.service";
import { GrnService } from "../grn.service";

/**
 * A purchase order could be raised into, redirected into, and received into a
 * building the caller holds nothing in.
 *
 * A PO is stock arriving INTO a warehouse and the caller has to hold the
 * building it lands in. A transfer's far end is deliberately spared — an
 * operator moving stock across the estate routinely holds no part of it — but a
 * PO's counterparty is a vendor, outside the scope system entirely, so the only
 * warehouse it names is the one it is delivered to.
 *
 * Every other door on this record already agreed: `listPos` and `getPo` filter
 * on the caller's warehouses and `updatePo`, `approvePo` and `sendPo` each
 * assert the PO's own warehouse. Three ways in did not.
 */

type VisibilityMock = jest.Mock<Promise<void>, [string, string, number | null | undefined]>;

function refusing(): VisibilityMock {
  return jest.fn(
    async (_orgId: string, _userId: string, _warehouseId: number | null | undefined) => {
      throw new NotFoundException("Not found");
    },
  );
}

function permitting(): VisibilityMock {
  return jest.fn(
    async (_orgId: string, _userId: string, _warehouseId: number | null | undefined) => {},
  );
}

interface PoFixture {
  service: PoService;
  nextNumber: jest.Mock<Promise<string>, [string, string]>;
  insert: jest.Mock<never, [unknown]>;
  findFirst: jest.Mock<Promise<unknown>, [unknown]>;
}

function poServiceWith(assertWarehouseVisible: VisibilityMock): PoFixture {
  const stub = {} as never;
  /*
   * `insert` and `findFirst` THROW, so each case below asserts the write is
   * never REACHED rather than that an exception came back — a service that
   * inserted the header and then refused would still have written it, and a
   * plain "rejects" assertion cannot tell those two apart. `findFirst` throwing
   * is also what pins the ORDERING on the update: the gate has to precede the
   * lookup, and a gate that moved below it would reject with that marker
   * instead.
   */
  const insert = jest.fn((_table: unknown): never => {
    throw new Error("the write must not be reached");
  });
  const findFirst = jest.fn(async (_args: unknown) => {
    throw new Error("the purchase order lookup must not be reached");
  });
  const db = {
    insert,
    query: { invPurchaseOrders: { findFirst } },
  } as never;
  const nextNumber = jest.fn(async (_orgId: string, _kind: string) => "PO-0001");
  return {
    service: new PoService(
      db,
      stub,
      stub,
      { next: nextNumber } as never,
      { assertWarehouseVisible } as never,
      stub,
      stub,
    ),
    nextNumber,
    insert,
    findFirst,
  };
}

describe("raising a purchase order", () => {
  it("refuses a warehouse the caller cannot see, before anything is written", async () => {
    const assertWarehouseVisible = refusing();
    const { service, nextNumber, insert } = poServiceWith(assertWarehouseVisible);

    await expect(
      service.createPo("org-1", "keeper-1", { warehouseId: 9, lines: [] } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(assertWarehouseVisible).toHaveBeenCalledWith("org-1", "keeper-1", 9);
    expect(insert).not.toHaveBeenCalled();
    // Ahead of the order number, so a refused order does not burn a PO number
    // out of the organisation's sequence.
    expect(nextNumber).not.toHaveBeenCalled();
  });

  it("does not ask when no warehouse is given, because a draft without one is legitimate", async () => {
    // `inv_purchase_orders.warehouse_id` is nullable and the field is optional.
    // Refusing a PO that names no warehouse yet would be a new restriction
    // rather than a closed hole.
    const assertWarehouseVisible = permitting();
    const { service } = poServiceWith(assertWarehouseVisible);

    await expect(
      service.createPo("org-1", "keeper-1", { lines: [] } as never),
    ).rejects.toThrow(/write must not be reached/);

    expect(assertWarehouseVisible).not.toHaveBeenCalled();
  });
});

describe("editing a purchase order", () => {
  it("refuses being redirected into a warehouse the caller cannot see", async () => {
    /*
     * `updatePo` already asserted the PO's own warehouse — may this caller touch
     * this record — and said nothing about where they were moving it TO. Editing
     * a draft was therefore a way in that `createPo` refuses.
     */
    const assertWarehouseVisible = refusing();
    const { service, findFirst } = poServiceWith(assertWarehouseVisible);

    await expect(
      service.updatePo("org-1", 42, "keeper-1", { warehouseId: 9 } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(assertWarehouseVisible).toHaveBeenCalledWith("org-1", "keeper-1", 9);
    // First: no query about the purchase order on behalf of a caller who may
    // not see the warehouse they named, and nothing in the refusal's shape that
    // says whether order 42 exists or is still a draft.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("does not ask when the patch leaves the warehouse alone", async () => {
    const assertWarehouseVisible = permitting();
    const { service } = poServiceWith(assertWarehouseVisible);

    await expect(service.updatePo("org-1", 42, "keeper-1", {} as never)).rejects.toThrow(
      /purchase order lookup must not be reached/,
    );

    expect(assertWarehouseVisible).not.toHaveBeenCalled();
  });
});

/**
 * The receipt's DEFAULT location, which is the half of `resolveLocation` that
 * was never asserted.
 *
 * A `locationId` in the body has been checked since it was written. With none,
 * the receipt falls back to the first active location of the *purchase order's*
 * warehouse — and `loadReceivablePo` looks the PO up on `org_id` alone, so a
 * body naming somebody else's purchase order received goods into somebody
 * else's building. A draft posts no movements, so the engine's
 * `assertLocationsInScope` never ran on it either.
 */
describe("drafting a goods receipt with no location named", () => {
  function grnServiceWith(assertWarehouseVisible: VisibilityMock) {
    const stub = {} as never;
    const transaction = jest.fn(async (_run: unknown) => {
      throw new Error("the transaction must not be reached");
    });
    const findFirst = jest.fn(async (_args: unknown) => ({
      id: 7,
      status: "SENT",
      warehouseId: 9,
      lines: [],
    }));
    const db = { transaction, query: { invPurchaseOrders: { findFirst } } } as never;
    const resolveLocationId = jest.fn(async (_orgId: string, _warehouseId: number | null) => 1);
    const service = new GrnService(
      db,
      stub,
      stub,
      stub,
      stub,
      stub,
      { resolveLocationId } as never,
      { assertWarehouseVisible } as never,
      stub,
      stub,
      stub,
      stub,
      stub,
    );
    return { service, transaction, resolveLocationId };
  }

  it("refuses the purchase order's own warehouse when the caller cannot see it", async () => {
    const assertWarehouseVisible = refusing();
    const { service, transaction, resolveLocationId } = grnServiceWith(assertWarehouseVisible);

    await expect(
      service.createDraft("org-1", "keeper-1", "key-1", { poId: 7, lines: [] } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(assertWarehouseVisible).toHaveBeenCalledWith("org-1", "keeper-1", 9);
    // Before the default location is even resolved, and long before the write.
    expect(resolveLocationId).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("still receives into the purchase order's warehouse when the caller holds it", async () => {
    // The control. This refuses no flow that completes today: a receipt that
    // actually posts movements into a warehouse the caller does not hold is
    // already refused by the engine, and an unrestricted caller passes both.
    const assertWarehouseVisible = permitting();
    const { service, resolveLocationId } = grnServiceWith(assertWarehouseVisible);

    await expect(
      service.createDraft("org-1", "keeper-1", "key-1", { poId: 7, lines: [] } as never),
    ).rejects.toThrow(/transaction must not be reached/);

    expect(resolveLocationId).toHaveBeenCalledWith("org-1", 9);
  });
});

/**
 * The four status transitions, which this file's own header has claimed assert
 * the purchase order's warehouse since it was written — and which nothing here
 * actually exercised.
 *
 * `approvePo`, `sendPo`, `closePo` and `cancelPo` each loaded the order and
 * called `assertWarehouseVisible` on it, four copies of the same three lines.
 * Extracting them into one `loadMovable` in `lib/po-lifecycle.ts` is what made
 * the gap visible: deleting that single call left all 62 tests across
 * `purchase-orders`, `inv-orders-isolation` and `inv-ops-isolation-4` green, so
 * a scoped operator could have approved, sent, closed or cancelled an order
 * into a building they hold nothing in and no suite would have said so.
 *
 * Every case asserts the write is never REACHED rather than that an exception
 * came back, for the same reason the cases above do: a transition that updated
 * the row and then refused would still have moved the order.
 */
describe("moving a purchase order through its statuses", () => {
  interface PoRow {
    id: number;
    status: string;
    warehouseId: number | null;
    approvedBy: string | null;
  }

  function lifecycleServiceWith(assertWarehouseVisible: VisibilityMock, po: PoRow) {
    const stub = {} as never;
    const reject = (what: string) =>
      jest.fn((): never => {
        throw new Error(`the ${what} must not be reached`);
      });
    const update = reject("status update");
    const transaction = reject("transaction");
    const select = reject("receipt count");
    const findFirst = jest.fn(async (_args: unknown) => po);
    const db = {
      update,
      transaction,
      select,
      query: { invPurchaseOrders: { findFirst } },
    } as never;
    const settings = { get: jest.fn(async (_orgId: string) => ({ requirePoApproval: true })) };
    const service = new PoService(
      db,
      stub,
      settings as never,
      stub,
      { assertWarehouseVisible } as never,
      stub,
      stub,
    );
    return { service, update, transaction, select, findFirst };
  }

  const DRAFT: PoRow = { id: 42, status: "DRAFT", warehouseId: 9, approvedBy: "approver-1" };
  const RECEIVED: PoRow = { id: 42, status: "RECEIVED", warehouseId: 9, approvedBy: null };

  const CASES: ReadonlyArray<
    readonly [string, PoRow, (s: PoService) => Promise<unknown>, "update" | "transaction" | "select"]
  > = [
    ["approvePo", DRAFT, (s) => s.approvePo("org-1", 42, "keeper-1"), "update"],
    ["sendPo", DRAFT, (s) => s.sendPo("org-1", 42, "keeper-1"), "transaction"],
    ["closePo", RECEIVED, (s) => s.closePo("org-1", 42, "keeper-1"), "transaction"],
    ["cancelPo", DRAFT, (s) => s.cancelPo("org-1", 42, "keeper-1"), "select"],
  ];

  for (const [name, row, call, write] of CASES) {
    it(`${name} refuses an order in a warehouse the caller cannot see`, async () => {
      const assertWarehouseVisible = refusing();
      const fixture = lifecycleServiceWith(assertWarehouseVisible, row);

      await expect(call(fixture.service)).rejects.toBeInstanceOf(NotFoundException);

      // The order's own warehouse, read off the row — not anything the caller sent.
      expect(assertWarehouseVisible).toHaveBeenCalledWith("org-1", "keeper-1", 9);
      expect(fixture[write]).not.toHaveBeenCalled();
    });

    it(`${name} still moves the order when the caller holds its warehouse`, async () => {
      // The anti-vacuity floor. Without it a service that threw NotFound
      // unconditionally — or one whose status guard refused first — would
      // satisfy the case above while asserting nothing about the gate.
      const assertWarehouseVisible = permitting();
      const fixture = lifecycleServiceWith(assertWarehouseVisible, row);

      await expect(call(fixture.service)).rejects.toThrow(/must not be reached/);

      expect(assertWarehouseVisible).toHaveBeenCalledWith("org-1", "keeper-1", 9);
      expect(fixture.findFirst).toHaveBeenCalled();
    });
  }
});
