import { NotFoundException } from "@nestjs/common";
import { InvStockTransfersService } from "../inv-stock-transfers.service";

/**
 * A transfer could be drafted out of a building the caller holds nothing in.
 *
 * `createTransferInTx` is two plain inserts — no stock engine, no movements —
 * so nothing checked either location, and `fromLocationId` came straight off the
 * request body. The engine's own `assertLocationsInScope` only runs when
 * movements post, which is later and only if there are any.
 *
 * The source is asserted and the destination is not, on purpose: an operator in
 * one building sending stock to another will routinely hold no part of the
 * destination, and requiring both would refuse every legitimate inter-warehouse
 * transfer. Taking stock OUT of a building you hold nothing in is the move with
 * no honest reading.
 */

const INPUT = {
  fromLocationId: 100,
  toLocationId: 200,
  lines: [{ productVariantId: 11, quantity: "5" }],
} as never;

function serviceWith(assertLocationVisible: jest.Mock): InvStockTransfersService {
  const stub = {} as never;
  const db = {
    transaction: jest.fn(async () => {
      throw new Error("the transaction must not be reached");
    }),
  } as never;
  return new InvStockTransfersService(
    db,
    stub,
    stub,
    stub,
    stub,
    { assertLocationVisible } as never,
    stub,
  );
}

describe("drafting a stock transfer", () => {
  it("refuses a source location the caller cannot see, before anything is written", async () => {
    /*
     * The db mock THROWS on `transaction`, so this asserts the write is never
     * reached rather than that an exception came back — a service that inserted
     * the rows and then refused would still have written them, and a plain
     * "rejects" assertion could not tell the two apart.
     */
    const assertLocationVisible = jest.fn(async () => {
      throw new NotFoundException("Not found");
    });
    const service = serviceWith(assertLocationVisible);

    await expect(
      service.createTransfer("org-1", "keeper-1", INPUT, "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(assertLocationVisible).toHaveBeenCalledWith("org-1", "keeper-1", 100);
  });

  it("asks about the source and not the destination", async () => {
    const assertLocationVisible = jest.fn(async () => {
      throw new NotFoundException("Not found");
    });
    const service = serviceWith(assertLocationVisible);

    await expect(
      service.createTransfer("org-1", "keeper-1", INPUT, "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Exactly one question, about `fromLocationId`. If a later change starts
    // asserting the destination too, this fails and the product rule above has
    // to be revisited deliberately rather than drifted into.
    expect(assertLocationVisible).toHaveBeenCalledTimes(1);
    expect(assertLocationVisible.mock.calls[0]?.[2]).toBe(100);
  });

  it("still refuses a transfer whose two ends are the same, before asking anything", async () => {
    const assertLocationVisible = jest.fn(async () => {});
    const service = serviceWith(assertLocationVisible);

    await expect(
      service.createTransfer("org-1", "keeper-1", { ...INPUT, toLocationId: 100 } as never, "key-1"),
    ).rejects.toThrow(/must be different/);
    expect(assertLocationVisible).not.toHaveBeenCalled();
  });
});
