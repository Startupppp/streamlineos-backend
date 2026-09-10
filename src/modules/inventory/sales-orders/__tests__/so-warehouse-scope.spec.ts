import { NotFoundException } from "@nestjs/common";
import { SoCoreService } from "../so-core.service";

/**
 * A sales order could be raised into, or edited into, a building the caller
 * holds nothing in.
 *
 * `data.warehouseId` came straight off the request body on both the create and
 * the update and was written unchecked. Nothing downstream catches it: raising
 * or editing an order posts no movements, so the stock engine's
 * `assertLocationsInScope` never runs on either path.
 *
 * A sales order ships OUT of its warehouse, so the rule is a transfer's source
 * rule — only out of a building you hold. `listSos` already gates on exactly
 * that, so an order raised into a warehouse the caller cannot see vanishes from
 * their own list while standing as demand against somebody else's shelves.
 */

type VisibilityMock = jest.Mock<Promise<void>, [string, string, number | null | undefined]>;

/** Refuses whatever it is asked about, so any question at all becomes visible. */
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

interface Fixture {
  service: SoCoreService;
  nextNumber: jest.Mock<Promise<string>, [string, string]>;
  findFirst: jest.Mock<Promise<unknown>, [unknown]>;
}

function serviceWith(assertWarehouseVisible: VisibilityMock): Fixture {
  const stub = {} as never;
  /*
   * `transaction` THROWS, so every case below asserts the write is never
   * REACHED rather than that an exception came back. A service that inserted
   * the header and then refused would still have written it, and a plain
   * "rejects" assertion cannot tell those two apart.
   *
   * `query.invSalesOrders.findFirst` throws its own marker for the same reason:
   * on the update path the order lookup is the first thing the gate has to
   * precede, so the ordering is asserted rather than described.
   */
  const findFirst = jest.fn(async (_args: unknown) => {
    throw new Error("the order lookup must not be reached");
  });
  const db = {
    transaction: jest.fn(async () => {
      throw new Error("the transaction must not be reached");
    }),
    query: { invSalesOrders: { findFirst } },
  } as never;
  const nextNumber = jest.fn(async (_orgId: string, _kind: string) => "SO-0001");
  return {
    service: new SoCoreService(db, stub, { next: nextNumber } as never, stub, {
      assertWarehouseVisible,
      /*
       * `updateSo` now also asks which orders this caller may TOUCH, not only
       * which warehouse they may move one into — the source half of the same
       * rule, gated on `soInScope`. Unrestricted here, so these cases keep
       * measuring exactly what they were written to measure: whether the
       * DESTINATION question was asked, and whether it was asked first.
       */
      forUser: async () => ({
        key: "all",
        isEmpty: false,
        unrestricted: true,
        warehouse: () => ({ queryChunks: [] }),
        location: () => ({ queryChunks: [] }),
        anyOf: () => ({ queryChunks: [] }),
      }),
    } as never),
    nextNumber,
    findFirst,
  };
}

describe("raising a sales order", () => {
  it("refuses a warehouse the caller cannot see, before anything is written", async () => {
    const assertWarehouseVisible = refusing();
    const { service, nextNumber } = serviceWith(assertWarehouseVisible);

    await expect(
      service.createSo("org-1", "keeper-1", { warehouseId: 9, lines: [] } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(assertWarehouseVisible).toHaveBeenCalledWith("org-1", "keeper-1", 9);
    // Ahead of the order number: a refused order must not move the
    // organisation's SO sequence on, and a caller who may not see the warehouse
    // should cause no work on its behalf.
    expect(nextNumber).not.toHaveBeenCalled();
  });

  it("does not ask when no warehouse is given, because a draft without one is legitimate", async () => {
    // `inv_sales_orders.warehouse_id` is nullable. An order with no warehouse
    // yet is a draft, not an attempt at somebody else's building, and refusing
    // it would be a new restriction rather than a closed hole.
    const assertWarehouseVisible = permitting();
    const { service } = serviceWith(assertWarehouseVisible);

    await expect(
      // The schema requires at least one line; an empty array keeps the fixture
      // from needing a variant-lookup stub, and what is asserted here is that no
      // visibility question was asked and execution carried on to the write.
      service.createSo("org-1", "keeper-1", { lines: [] } as never),
    ).rejects.toThrow(/transaction must not be reached/);

    expect(assertWarehouseVisible).not.toHaveBeenCalled();
  });
});

describe("editing a sales order", () => {
  it("refuses a warehouse the caller cannot see, before the order is even looked up", async () => {
    const assertWarehouseVisible = refusing();
    const { service, findFirst } = serviceWith(assertWarehouseVisible);

    await expect(
      service.updateSo("org-1", 42, "keeper-1", { warehouseId: 9 } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(assertWarehouseVisible).toHaveBeenCalledWith("org-1", "keeper-1", 9);
    /*
     * The gate runs FIRST. A caller naming a warehouse they cannot see should
     * cause no query about the order, and should not be able to read the
     * refusal's shape to learn whether order 42 exists or is still a draft.
     * `findFirst` throws a plain Error, so if the gate ever moved below it this
     * case would reject with that instead and `toBeInstanceOf` above would fail.
     */
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("does not ask when the patch leaves the warehouse alone", async () => {
    // `undefined` means "leave it as it is". Only a value the caller actually
    // supplied is theirs to justify.
    const assertWarehouseVisible = permitting();
    const { service } = serviceWith(assertWarehouseVisible);

    await expect(service.updateSo("org-1", 42, "keeper-1", {} as never)).rejects.toThrow(
      /order lookup must not be reached/,
    );

    expect(assertWarehouseVisible).not.toHaveBeenCalled();
  });
});
