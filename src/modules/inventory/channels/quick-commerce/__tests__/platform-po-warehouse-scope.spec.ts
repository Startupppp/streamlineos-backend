import { BadRequestException, NotFoundException } from "@nestjs/common";
import { QuickCommerceInboundService } from "../quick-commerce-inbound.service";

/**
 * A platform purchase order could be ingested against a building the caller
 * holds nothing in.
 *
 * `input.warehouseId` came straight off the request body and was written
 * unchecked. Nothing downstream catches it: ingesting posts no movements, so the
 * stock engine's `assertLocationsInScope` never runs on this path.
 *
 * The rule was already settled by this service's own siblings —
 * `acceptPurchaseOrder` asserts the warehouse it raises a Streamline PO into and
 * `createAsn` asserts the one it books a dock appointment against. Ingest is the
 * door both are reached through, and it was the one that did not ask.
 */

type VisibilityMock = jest.Mock<Promise<void>, [string, string, number | null | undefined]>;

interface Fixture {
  service: QuickCommerceInboundService;
  settingsGet: jest.Mock<Promise<unknown>, [string]>;
}

function serviceWith(assertWarehouseVisible: VisibilityMock): Fixture {
  const stub = {} as never;
  /*
   * The db stub has ONLY `transaction`, and that throws. So the write is proved
   * unreachable rather than merely refused, and any query attempted before the
   * gate TypeErrors instead of passing quietly — which is what makes the
   * ordering an assertion.
   */
  const db = {
    transaction: jest.fn(async () => {
      throw new Error("the transaction must not be reached");
    }),
  } as never;
  const settingsGet = jest.fn(async (_orgId: string) => ({
    packs: { quickCommerce: false },
    qcZeptoEmailPoEnabled: false,
  }));
  return {
    service: new QuickCommerceInboundService(
      db,
      { get: settingsGet } as never,
      stub,
      stub,
      stub,
      { assertWarehouseVisible } as never,
      stub,
    ),
    settingsGet,
  };
}

describe("ingesting a platform purchase order", () => {
  it("refuses a warehouse the caller cannot see, before anything is read or written", async () => {
    const assertWarehouseVisible: VisibilityMock = jest.fn(
      async (_orgId: string, _userId: string, _warehouseId: number | null | undefined) => {
        throw new NotFoundException("Not found");
      },
    );
    const { service, settingsGet } = serviceWith(assertWarehouseVisible);

    await expect(
      service.ingestPurchaseOrder(
        "org-1",
        "keeper-1",
        { provider: "BLINKIT", payload: {}, warehouseId: 9 } as never,
        "key-1",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(assertWarehouseVisible).toHaveBeenCalledWith("org-1", "keeper-1", 9);
    /*
     * The gate is FIRST — ahead of the settings read, the adapter, the parse and
     * the duplicate probe. A caller who may not see the warehouse causes no work
     * on its behalf, and cannot read the refusal's shape to learn which packs
     * this organisation has switched on. If the gate ever moved below the
     * settings read, this case would reject with a BadRequest about the pack
     * instead and `toBeInstanceOf(NotFoundException)` above would fail.
     */
    expect(settingsGet).not.toHaveBeenCalled();
  });

  it("does not ask when no warehouse is given, because a document may arrive before one is chosen", async () => {
    // The column is nullable and the field optional: a platform PO can
    // legitimately land before anyone has decided which building serves it, and
    // refusing those would be a new restriction rather than a closed hole.
    const assertWarehouseVisible: VisibilityMock = jest.fn(
      async (_orgId: string, _userId: string, _warehouseId: number | null | undefined) => {},
    );
    const { service, settingsGet } = serviceWith(assertWarehouseVisible);

    // Reaching the pack gate is the proof that execution carried on past the
    // warehouse question rather than being stopped by it.
    await expect(
      service.ingestPurchaseOrder(
        "org-1",
        "keeper-1",
        { provider: "BLINKIT", payload: {} } as never,
        "key-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(assertWarehouseVisible).not.toHaveBeenCalled();
    expect(settingsGet).toHaveBeenCalledWith("org-1");
  });
});
