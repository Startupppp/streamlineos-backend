import { BadRequestException } from "@nestjs/common";
import { PickConfirmService } from "../pick-confirm.service";
import { INV_ERRORS } from "../../stock-engine/stock-engine.types";

/**
 * R3, item 1 — a confirm ends at a real bin, or it is refused.
 *
 * `const pickedAt = input.locationId ?? line.locationId;` evaluated to null
 * whenever a wave line had never been allocated and the picker supplied no
 * location. The row was still updated with the picked quantity, and the
 * projection grain — which is keyed on (variant, location, lot, serial) — was
 * skipped, because there was no location to key it on. So `quantity_picked` said
 * the goods were in a tote while `outgoing_qty` never moved and availability
 * went on offering them to the next customer. No status was wrong and no ledger
 * was unbalanced; nothing but these cases catches it.
 *
 * Two behaviours are pinned here. A confirm with no location resolves one
 * server-side through the **same** shared allocator a wave create and a
 * sales-order reserve use, and a confirm that still cannot resolve one is a 400
 * rather than a silent success.
 */

const PICK_LINE = {
  id: 5,
  soLineId: 33,
  productVariantId: 100,
  locationId: null as number | null,
  lotId: null as number | null,
  serialId: null as number | null,
  quantityToPick: "5.0000",
  quantityPicked: "0.0000",
  exceptionReason: null,
  exceptionStatus: null,
  substituteVariantId: null,
  substituteQuantity: null,
};

function makeTx(line: typeof PICK_LINE) {
  // `loadPickLine` runs `select().from().where()` and destructures the first row,
  // so the chain has to be awaitable at the end rather than merely chainable.
  const select = jest.fn().mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const step = jest.fn(() => chain);
    chain.from = step;
    chain.where = step;
    // D2. `soIdForLine` ends its chain with `.limit(1)` — the line carries
    // `soLineId` and the customer's shelf-life floor hangs off the order, so the
    // confirm path looks the order up. Without this the chain is merely
    // chainable and not awaitable at that step.
    chain.limit = step;
    chain.then = (resolve: (rows: unknown[]) => unknown) => resolve([line]);
    return chain;
  });

  const setWhere = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where: setWhere });

  return {
    select,
    // The idempotency claim: insert ... on conflict do nothing ... returning.
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 1 }]),
        }),
        returning: jest.fn().mockResolvedValue([{ id: 1 }]),
      }),
    }),
    update: jest.fn().mockReturnValue({ set }),
    // `loadWaveContext` is the only raw statement the confirm path runs.
    execute: jest.fn().mockResolvedValue([{ created_by: "planner", warehouse_id: 7 }]),
    query: { invIdempotencyKeys: { findFirst: jest.fn().mockResolvedValue(undefined) } },
    __set: set,
  };
}

function buildService(options: {
  line?: Partial<typeof PICK_LINE>;
  foundLot?: { locationId: number; lotId?: number } | null;
}) {
  const line = { ...PICK_LINE, ...options.line };
  const tx = makeTx(line);
  const db = {
    transaction: jest.fn().mockImplementation((fn: (t: unknown) => unknown) => fn(tx)),
    // D2. `resolvePickConstraints` reads the customer's shelf-life rules off the
    // bare handle, not the transaction — it is policy, not part of the write. No
    // rules configured is the default case and resolves to a floor of zero days,
    // which is the behaviour every organisation has until it writes one.
    select: jest.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      const step = jest.fn(() => chain);
      chain.from = step;
      chain.where = step;
      chain.orderBy = step;
      chain.limit = step;
      chain.then = (resolve: (rows: unknown[]) => unknown) => resolve([]);
      return chain;
    }),
  };
  const barcode = { scan: jest.fn() };
  const completion = {
    claimForConfirm: jest.fn().mockResolvedValue(undefined),
    consumeCoveredReservations: jest.fn().mockResolvedValue([]),
    rollUpSoStatus: jest.fn().mockResolvedValue(undefined),
    finishWave: jest.fn().mockResolvedValue(false),
    syncGrains: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { insert: jest.fn().mockResolvedValue(undefined) };
  const settings = {
    get: jest.fn().mockResolvedValue({
      reservationStrategy: "FIFO",
      expiryReservationPolicy: "BLOCK",
      nearExpiryPolicy: "DEPRIORITIZE",
      nearExpiryWindowDays: 30,
    }),
  };
  const soCore = {
    findAvailableLotForLine: jest.fn().mockResolvedValue(options.foundLot ?? null),
  };

  // NEO-7's labour recorder. A no-op double rather than a jest.fn assertion
  // target: this spec is about which location a confirm resolves to, and the
  // labour record is asserted where it belongs, in `labor.spec.ts`.
  const labor = { recordInTx: jest.fn(async () => undefined) };

  const svc = new PickConfirmService(
    db as never,
    barcode as never,
    completion as never,
    audit as never,
    settings as never,
    soCore as never,
    labor as never,
  );
  return { svc, tx, completion, soCore, audit };
}

describe("PickConfirmService — where the units came from", () => {
  it("uses the bin the wave allocated, without asking the allocator again", async () => {
    const { svc, completion, soCore } = buildService({ line: { locationId: 42 } });

    await svc.confirmPick("org1", "picker", 1, { pickLineId: 5, quantityPicked: "2.0000" }, "k1");

    expect(soCore.findAvailableLotForLine).not.toHaveBeenCalled();
    expect(completion.syncGrains).toHaveBeenCalledWith(
      expect.anything(),
      "org1",
      expect.arrayContaining([expect.objectContaining({ locationId: 42 })]),
    );
  });

  it("lets the picker's own bin win over the wave's", async () => {
    // They are standing at it. `WRONG_LOCATION` exists for reporting that the
    // wave was wrong; a confirm is not the place to argue with the shelf.
    const { svc, completion } = buildService({ line: { locationId: 42 } });

    await svc.confirmPick(
      "org1",
      "picker",
      1,
      { pickLineId: 5, quantityPicked: "2.0000", locationId: 43 },
      "k2",
    );

    expect(completion.syncGrains).toHaveBeenCalledWith(
      expect.anything(),
      "org1",
      expect.arrayContaining([
        expect.objectContaining({ locationId: 43 }),
        // B5. The bin the line used to stand on is recomputed too, or the
        // quantity computed there stays until nothing ever recomputes it.
        expect.objectContaining({ locationId: 42 }),
      ]),
    );
  });

  it("resolves a bin server-side when the line has none and the picker names none", async () => {
    const { svc, completion, soCore } = buildService({
      line: { locationId: null },
      foundLot: { locationId: 77, lotId: 3 },
    });

    await svc.confirmPick("org1", "picker", 1, { pickLineId: 5, quantityPicked: "2.0000" }, "k3");

    // Through the shared helper, with the wave's warehouse and the org's own
    // reservation strategy — not a private "where is this SKU" query, which is
    // how picking once came to promise expired lots.
    expect(soCore.findAvailableLotForLine).toHaveBeenCalledWith(
      "org1",
      100,
      7,
      "2.0000",
      "FIFO",
      "BLOCK",
      // D2. The seventh argument is the point: a confirm that resolves its own
      // bin now allocates under the same near-expiry tier and customer
      // shelf-life floor auto-reserve honours. Every picking call site used to
      // stop at "BLOCK", so a substitution could hand a customer a lot the
      // reserve path had refused minutes earlier.
      { nearExpiryPolicy: "DEPRIORITIZE", nearExpiryWindowDays: 30, minShelfLifeDays: 0 },
    );
    expect(completion.syncGrains).toHaveBeenCalledWith(
      expect.anything(),
      "org1",
      [{ productVariantId: 100, locationId: 77, lotId: 3, serialId: null }],
    );
  });

  it("stamps the resolved bin on the line, so it stops needing a decision", async () => {
    const { svc, tx } = buildService({
      line: { locationId: null },
      foundLot: { locationId: 77, lotId: 3 },
    });

    await svc.confirmPick("org1", "picker", 1, { pickLineId: 5, quantityPicked: "2.0000" }, "k4");

    expect(tx.__set).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: 77, lotId: 3, quantityPicked: "2.0000" }),
    );
  });

  it("refuses the confirm outright when no bin can be resolved", async () => {
    const { svc, completion } = buildService({ line: { locationId: null }, foundLot: null });

    await expect(
      svc.confirmPick("org1", "picker", 1, { pickLineId: 5, quantityPicked: "2.0000" }, "k5"),
    ).rejects.toThrow(BadRequestException);

    // And nothing moved. The defect was that this path succeeded.
    expect(completion.syncGrains).not.toHaveBeenCalled();
  });

  it("names LOCATION_NOT_FOUND rather than failing as a 500 or succeeding quietly", async () => {
    const { svc } = buildService({ line: { locationId: null }, foundLot: null });

    await svc
      .confirmPick("org1", "picker", 1, { pickLineId: 5, quantityPicked: "2.0000" }, "k6")
      .then(
        () => {
          throw new Error("confirm should have been refused");
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(BadRequestException);
          expect((error as BadRequestException).getResponse()).toMatchObject({
            code: INV_ERRORS.LOCATION_NOT_FOUND,
          });
        },
      );
  });
});
