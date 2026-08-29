import {
  allocateFromAvailableStock,
  allocateWaveLines,
  type LotFinder,
} from "../pick-allocation";

/**
 * R3, item 1 — a wave line either names a bin or says it needs a decision.
 *
 * The old return type let those be the same value: `{ locationId: null }`. Every
 * caller had to remember the null, and `confirmPick` did not — it wrote the
 * picked quantity and skipped the projection grain, so goods in a tote stayed
 * sellable and nothing anywhere reported an error. These cases pin the union, and
 * with it the two ways a line comes to have no bin.
 */

const LINES = [
  { soLineId: 10, productVariantId: 100, quantity: "5.0000" },
  { soLineId: 11, productVariantId: 101, quantity: "3.0000" },
];

function makeDb(reserved: ReadonlyArray<Record<string, unknown>>) {
  return { execute: jest.fn().mockResolvedValue(reserved) };
}

describe("allocateFromAvailableStock", () => {
  it("reports NEEDS_DECISION when the shared allocator finds nothing", async () => {
    const findLot: LotFinder = jest.fn().mockResolvedValue(null);
    await expect(allocateFromAvailableStock(findLot, 100, "5.0000")).resolves.toEqual({
      status: "NEEDS_DECISION",
    });
  });

  it("carries the bin and lot the allocator resolved, and never a serial", async () => {
    // The shared helper resolves a lot, never a serial, because a sales-order
    // reserve does not either — a serial-tracked line is settled from the scan
    // at the shelf, which is the only place the actual unit is known.
    const findLot: LotFinder = jest.fn().mockResolvedValue({ locationId: 55, lotId: 9 });
    await expect(allocateFromAvailableStock(findLot, 100, "5.0000")).resolves.toEqual({
      status: "ALLOCATED",
      locationId: 55,
      lotId: 9,
      serialId: null,
    });
  });
});

describe("allocateWaveLines", () => {
  it("asks nothing at all for an empty wave", async () => {
    const db = makeDb([]);
    const findLot: LotFinder = jest.fn();
    await expect(allocateWaveLines(db as never, "org1", [], findLot)).resolves.toEqual(new Map());
    expect(db.execute).not.toHaveBeenCalled();
    expect(findLot).not.toHaveBeenCalled();
  });

  it("prefers the reservation that already promised these units", async () => {
    // Reserving is the moment stock was promised, and it named a row. Sending
    // the picker anywhere else splits the promise from the goods: `committed`
    // sits on the reserved bin and `outgoing_qty` lands on the picked one, and
    // availability is reduced twice for one set of units.
    const db = makeDb([
      { source_line_id: "10", location_id: 42, lot_id: 7, serial_id: null },
    ]);
    const findLot: LotFinder = jest.fn().mockResolvedValue({ locationId: 99 });

    const out = await allocateWaveLines(db as never, "org1", [LINES[0]!], findLot);

    expect(out.get(10)).toEqual({
      status: "ALLOCATED",
      locationId: 42,
      lotId: 7,
      serialId: null,
    });
    expect(findLot).not.toHaveBeenCalled();
  });

  it("falls through to the shared allocator when a reservation names no bin", async () => {
    // R3. `location_id` is nullable on `inv_stock_reservations` — a
    // warehouse-level hold names no bin — and taking one of those still counted
    // as "allocated", which blocked the fallback and left the line with nowhere
    // to walk to. A reservation that cannot say where the goods are is no answer.
    const db = makeDb([
      { source_line_id: "10", location_id: null, lot_id: null, serial_id: null },
    ]);
    const findLot: LotFinder = jest.fn().mockResolvedValue({ locationId: 77, lotId: 3 });

    const out = await allocateWaveLines(db as never, "org1", [LINES[0]!], findLot);

    expect(out.get(10)).toEqual({
      status: "ALLOCATED",
      locationId: 77,
      lotId: 3,
      serialId: null,
    });
    expect(findLot).toHaveBeenCalledWith(100, "5.0000");
  });

  it("still creates the line when nothing resolves, flagged as needing a decision", async () => {
    // The demand is real, so the line is real. What changes is that "no bin" is
    // a state the caller is handed rather than a null nobody reads.
    const db = makeDb([]);
    const findLot: LotFinder = jest.fn().mockResolvedValue(null);

    const out = await allocateWaveLines(db as never, "org1", LINES, findLot);

    expect(out.get(10)).toEqual({ status: "NEEDS_DECISION" });
    expect(out.get(11)).toEqual({ status: "NEEDS_DECISION" });
    expect(out.size).toBe(2);
  });

  it("mixes the two sources across one wave", async () => {
    const db = makeDb([
      { source_line_id: "11", location_id: 42, lot_id: null, serial_id: null },
    ]);
    const findLot: LotFinder = jest.fn().mockResolvedValue(null);

    const out = await allocateWaveLines(db as never, "org1", LINES, findLot);

    expect(out.get(11)).toEqual({
      status: "ALLOCATED",
      locationId: 42,
      lotId: null,
      serialId: null,
    });
    expect(out.get(10)).toEqual({ status: "NEEDS_DECISION" });
    expect(findLot).toHaveBeenCalledTimes(1);
  });
});
