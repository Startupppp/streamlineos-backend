import { NotFoundException } from "@nestjs/common";
import { PickWaveService } from "../pick-wave.service";

/**
 * Both wave entrances take `warehouseId` from the request body, and both were
 * already gated — `planWaveLines` opens with `assertWarehouseVisible` and
 * `createWave` and `joinWave` share it. That is pinned here rather than assumed,
 * because a census flagged both and "the assert lives in a helper" is a claim a
 * later refactor can quietly falsify.
 *
 * What was wrong was WHERE the gate ran on the join. The wave was looked up
 * first, so a caller naming a warehouse they hold nothing in could tell "Pick
 * wave not found" from "Not found" and read the existence of any pick list in
 * the organisation off the difference. Both are 404s, which is how it survived a
 * reading; §4 calls it an existence oracle all the same.
 */

type VisibilityMock = jest.Mock<Promise<void>, [string, string, number | null | undefined]>;

const INPUT = { warehouseId: 9, soIds: [1, 2] };

function refusing(): VisibilityMock {
  return jest.fn(
    async (_orgId: string, _userId: string, _warehouseId: number | null | undefined) => {
      throw new NotFoundException("Not found");
    },
  );
}

interface Fixture {
  service: PickWaveService;
  waveLookup: jest.Mock<Promise<unknown>, [unknown]>;
  orderLookup: jest.Mock<Promise<unknown>, [unknown]>;
  transaction: jest.Mock<Promise<unknown>, [unknown]>;
}

function serviceWith(assertWarehouseVisible: VisibilityMock): Fixture {
  const stub = {} as never;
  /*
   * Every db entry point THROWS a marker of its own, so each case asserts what
   * was REACHED rather than only what came back. A gate that refused after
   * writing would still have written, and a plain "rejects" assertion cannot
   * tell those apart.
   */
  const waveLookup = jest.fn(async (_args: unknown) => {
    throw new Error("the wave lookup must not be reached");
  });
  const orderLookup = jest.fn(async (_args: unknown) => {
    throw new Error("the orders were planned");
  });
  const transaction = jest.fn(async (_run: unknown) => {
    throw new Error("the transaction must not be reached");
  });
  const db = {
    transaction,
    query: {
      invPickLists: { findFirst: waveLookup },
      invSalesOrders: { findMany: orderLookup },
    },
  } as never;
  return {
    service: new PickWaveService(
      db,
      { assertWarehouseVisible } as never,
      stub,
      stub,
      stub,
      stub,
    ),
    waveLookup,
    orderLookup,
    transaction,
  };
}

describe("raising a pick wave", () => {
  it("refuses a warehouse the caller cannot see, before anything is read or written", async () => {
    // The census candidate at `createWave`. It delegates to `planWaveLines`,
    // which gates first thing — already correct, and pinned so it stays that
    // way.
    const assertWarehouseVisible = refusing();
    const { service, orderLookup, transaction } = serviceWith(assertWarehouseVisible);

    await expect(
      service.createWave("org-1", "picker-1", INPUT as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(assertWarehouseVisible).toHaveBeenCalledWith("org-1", "picker-1", 9);
    expect(orderLookup).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("joining a pick wave", () => {
  it("refuses the warehouse before the wave is even looked up", async () => {
    const assertWarehouseVisible = refusing();
    const { service, waveLookup, transaction } = serviceWith(assertWarehouseVisible);

    await expect(
      service.joinWave("org-1", "picker-1", 77, INPUT as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(assertWarehouseVisible).toHaveBeenCalledWith("org-1", "picker-1", 9);
    /*
     * The oracle this closes. With the lookup first, a caller who cannot see
     * warehouse 9 got "Pick wave not found" for a free id and "Not found" for a
     * taken one — the existence of every pick list in the organisation, readable
     * off the message. `waveLookup` throws a plain Error, so a gate that moved
     * back below it would reject with that and `toBeInstanceOf` above would fail.
     */
    expect(waveLookup).not.toHaveBeenCalled();
  });

  it("plans the orders before it looks the wave up, so the gate always runs first", async () => {
    // The positive half of the same ordering: with the warehouse allowed,
    // execution is in `planWaveLines` — past the gate — while the wave is still
    // unread.
    const assertWarehouseVisible: VisibilityMock = jest.fn(
      async (_orgId: string, _userId: string, _warehouseId: number | null | undefined) => {},
    );
    const { service, waveLookup, orderLookup } = serviceWith(assertWarehouseVisible);

    await expect(service.joinWave("org-1", "picker-1", 77, INPUT as never)).rejects.toThrow(
      /the orders were planned/,
    );

    expect(orderLookup).toHaveBeenCalled();
    expect(waveLookup).not.toHaveBeenCalled();
  });
});
