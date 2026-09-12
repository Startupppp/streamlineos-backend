import { NotFoundException } from "@nestjs/common";
import { ShipmentsService } from "../shipments.service";

/**
 * A shipment header could be created against a building the caller holds nothing in.
 *
 * `warehouseId` came straight off the request body and was written unchecked.
 * Nothing downstream catches it: creating a shipment posts no movements, so the
 * stock engine's `assertLocationsInScope` never runs on this path.
 *
 * A shipment ships OUT of a warehouse, so the rule is a transfer's source rule —
 * only out of a building you hold.
 */

type VisibilityMock = jest.Mock<Promise<void>, [string, string, number | null | undefined]>;

function serviceWith(assertWarehouseVisible: VisibilityMock): ShipmentsService {
  const stub = {} as never;
  const db = {
    transaction: jest.fn(async () => {
      throw new Error("the transaction must not be reached");
    }),
  } as never;
  const numSeq = { next: jest.fn(async () => "SHP-0001") } as never;
  return new ShipmentsService(db, stub, numSeq, stub, stub, { assertWarehouseVisible } as never);
}

describe("creating a shipment", () => {
  it("refuses a warehouse the caller cannot see, before anything is written", async () => {
    /*
     * The db mock THROWS on `transaction`, so this asserts the write is never
     * REACHED. A service that inserted the header and then refused would still
     * have written it, and a plain "rejects" assertion cannot tell those apart.
     */
    const assertWarehouseVisible: VisibilityMock = jest.fn(
      async (_orgId: string, _userId: string, _warehouseId: number | null | undefined) => {
        throw new NotFoundException("Not found");
      },
    );
    const service = serviceWith(assertWarehouseVisible);

    await expect(
      service.create("org-1", "keeper-1", { warehouseId: 9 } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(assertWarehouseVisible).toHaveBeenCalledWith("org-1", "keeper-1", 9);
  });

  it("does not ask when no warehouse is given, because a draft without one is legitimate", async () => {
    // The column is nullable. A shipment with no warehouse yet is a draft, not
    // an attempt at somebody else's building, and refusing it would be a new
    // restriction rather than a closed hole.
    const assertWarehouseVisible: VisibilityMock = jest.fn(
      async (_orgId: string, _userId: string, _warehouseId: number | null | undefined) => {},
    );
    const service = serviceWith(assertWarehouseVisible);

    await expect(service.create("org-1", "keeper-1", {} as never)).rejects.toThrow(
      /transaction must not be reached/,
    );
    expect(assertWarehouseVisible).not.toHaveBeenCalled();
  });
});
