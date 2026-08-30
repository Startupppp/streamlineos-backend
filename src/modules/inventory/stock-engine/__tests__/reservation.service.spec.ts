import { ReservationService } from "../reservation.service";

function makeUpdateChain() {
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where });
  return { set, where };
}

type MockTx = { execute: jest.Mock; update: jest.Mock };

function buildDb(tx: MockTx) {
  return {
    transaction: jest.fn().mockImplementation(async (fn: (tx: MockTx) => Promise<unknown>) => fn(tx)),
  };
}

const settings = { get: jest.fn() };

/**
 * NEO-1 added the channel-pool gate to `createReservationInTx`. `expireStale`
 * never reaches it, so a stub that would throw if it were called is the honest
 * double: it keeps this spec about expiry and fails loudly if the gate ever
 * migrates onto this path.
 */
const channelPools = {
  assertPromisable: jest.fn(() => {
    throw new Error("expireStale must not consult channel pools");
  }),
};

describe("ReservationService.expireStale", () => {
  it("returns 0 and performs no writes when nothing is stale", async () => {
    const tx: MockTx = { execute: jest.fn().mockResolvedValue([]), update: jest.fn() };
    const service = new ReservationService(buildDb(tx) as never, settings as never, channelPools as never);

    const count = await service.expireStale("org1");

    expect(count).toBe(0);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("marks stale reservations EXPIRED and decrements committed only for located ones", async () => {
    const stale = [
      { id: 1, location_id: 10, product_variant_id: 100, reserved_qty: "5.0000" },
      { id: 2, location_id: null, product_variant_id: 200, reserved_qty: "3.0000" },
    ];
    const chains: ReturnType<typeof makeUpdateChain>[] = [];
    const tx: MockTx = {
      execute: jest.fn().mockResolvedValue(stale),
      update: jest.fn().mockImplementation(() => {
        const c = makeUpdateChain();
        chains.push(c);
        return c;
      }),
    };
    const service = new ReservationService(buildDb(tx) as never, settings as never, channelPools as never);

    const count = await service.expireStale("org1");

    expect(count).toBe(2);
    // One bulk EXPIRED update via the query builder; the committed decrement now
    // goes through raw SQL so it can match lot and serial with IS NOT DISTINCT
    // FROM — matching on (org, variant, location) alone decremented every lot
    // row at that location.
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(chains[0].set).toHaveBeenCalledWith({ status: "EXPIRED" });
    // exactly one committed decrement — the null-location reservation is skipped
    const decrements = (tx.execute.mock.calls as unknown[][]).filter(([q]) =>
      JSON.stringify((q as { queryChunks?: unknown[] }).queryChunks ?? q).includes("committed"),
    );
    expect(decrements).toHaveLength(1);
  });
});
