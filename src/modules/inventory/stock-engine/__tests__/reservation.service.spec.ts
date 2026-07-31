import { ReservationService } from "../../reservation.service";

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

describe("ReservationService.expireStale", () => {
  it("returns 0 and performs no writes when nothing is stale", async () => {
    const tx: MockTx = { execute: jest.fn().mockResolvedValue([]), update: jest.fn() };
    const service = new ReservationService(buildDb(tx) as never, settings as never);

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
    const service = new ReservationService(buildDb(tx) as never, settings as never);

    const count = await service.expireStale("org1");

    expect(count).toBe(2);
    // one bulk EXPIRED update + exactly one committed decrement (the null-location reservation is skipped)
    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(chains[0].set).toHaveBeenCalledWith({ status: "EXPIRED" });
    expect(chains[1].set).toHaveBeenCalledTimes(1);
  });
});
