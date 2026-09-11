import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  insertGrnLines,
  loadReceivablePo,
  resolveLocation,
  type GrnDraftDeps,
  type ReceivablePo,
} from "../lib/grn-draft";
import { loadEditableGrn, type GrnTransitionDeps } from "../lib/grn-transitions";

/**
 * The gates between "somebody scanned a lorry" and a draft receipt existing.
 *
 * These were eight `private` methods on `GrnService`, reachable only by
 * standing up a service with thirteen constructor arguments, and seven of the
 * eight were asserted by nothing at all. Moving them into `lib/grn-draft.ts`
 * and `lib/grn-transitions.ts` is what showed that: neutralising every one of
 * them at once — both `assertLocationVisible` calls, `assertWarehouseVisible`,
 * the SENT/PARTIAL check, the EDITABLE check, the duplicate PO line and the
 * duplicate serial — left 40 of the 41 tests in `purchase-orders` green. The
 * one that noticed was `po-warehouse-scope.spec.ts` on the default-location
 * branch, and nothing in `test/inventory/*.seeded-e2e-spec.ts` mentions any of
 * the others.
 *
 * Three of them are authorization. `assertLocationVisible` is what stops a
 * scoped operator counting goods into, or editing a receipt standing at, a
 * building they hold nothing in — and a draft posts no stock movements, so the
 * stock engine's own `assertLocationsInScope` never runs to catch it later.
 *
 * Every case here asserts the write is never REACHED where there is one, rather
 * than that an exception came back: a receipt that inserted its header and then
 * refused would still have written it.
 */

function refusing() {
  return jest.fn(async (): Promise<void> => {
    throw new NotFoundException("Not found");
  });
}

function permitting() {
  return jest.fn(async (): Promise<void> => {});
}

interface Doors {
  assertWarehouseVisible: jest.Mock;
  assertLocationVisible: jest.Mock;
}

function draftDeps(db: unknown, doors: Doors, over: Partial<GrnDraftDeps> = {}): GrnDraftDeps {
  return {
    db,
    warehouseScope: doors,
    resolveDefaultLocationId: jest.fn(async () => 1),
    numSeq: { next: jest.fn(async () => "GRN-1") },
    uom: {
      convert: jest.fn(async (_o: string, _p: number, uomId: number | null, qty: string) => ({
        quantity: qty,
        quantityEntered: qty,
        uomId,
        uomFactor: "1",
      })),
    },
    quantityCapture: { assertEnteredQuantity: jest.fn(async () => {}) },
    handlingUnits: { assertCanHoldStockInTx: jest.fn(async () => {}) },
    audit: { insert: jest.fn(async () => {}) },
    ...over,
  } as unknown as GrnDraftDeps;
}

function transitionDeps(db: unknown, doors: Doors): GrnTransitionDeps {
  return {
    db,
    warehouseScope: doors,
    cache: {},
    audit: {},
    reads: {},
  } as unknown as GrnTransitionDeps;
}

function doorsThat(mode: "refuse" | "permit"): Doors {
  const make = mode === "refuse" ? refusing : permitting;
  return { assertWarehouseVisible: make(), assertLocationVisible: make() };
}

describe("the purchase order a receipt may be raised against", () => {
  function dbReturningPo(po: unknown) {
    const findFirst = jest.fn(async () => po);
    return { db: { query: { invPurchaseOrders: { findFirst } } }, findFirst };
  }

  it.each(["DRAFT", "RECEIVED", "CLOSED", "CANCELLED"])(
    "refuses a %s order, because goods arriving against one is a question not a delivery",
    async (status) => {
      const { db } = dbReturningPo({ id: 7, status, warehouseId: 9, lines: [] });
      await expect(
        loadReceivablePo(draftDeps(db, doorsThat("permit")), "org-1", 7),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each(["SENT", "PARTIAL"])("accepts a %s order", async (status) => {
    // The floor: a `loadReceivablePo` that refused everything would satisfy
    // every case above while asserting nothing about the status rule.
    const { db } = dbReturningPo({ id: 7, status, warehouseId: 9, lines: [] });
    await expect(
      loadReceivablePo(draftDeps(db, doorsThat("permit")), "org-1", 7),
    ).resolves.toMatchObject({ id: 7, status });
  });

  it("reads as absent when the order belongs to another tenant", async () => {
    const { db } = dbReturningPo(undefined);
    await expect(
      loadReceivablePo(draftDeps(db, doorsThat("permit")), "org-1", 7),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("where a receipt's goods are being put", () => {
  function dbWithLocation(loc: unknown) {
    const findFirst = jest.fn(async () => loc);
    return { db: { query: { invLocations: { findFirst } } }, findFirst };
  }

  it("refuses a named location the caller cannot see", async () => {
    // A draft posts no movements, so nothing downstream catches this: the stock
    // engine's `assertLocationsInScope` only runs when stock actually moves.
    const doors = doorsThat("refuse");
    const { db } = dbWithLocation({ id: 5 });
    await expect(
      resolveLocation(draftDeps(db, doors), "org-1", "keeper-1", 9, 5),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(doors.assertLocationVisible).toHaveBeenCalledWith("org-1", "keeper-1", 5);
  });

  it("accepts a named location the caller holds", async () => {
    const doors = doorsThat("permit");
    const { db } = dbWithLocation({ id: 5 });
    await expect(
      resolveLocation(draftDeps(db, doors), "org-1", "keeper-1", 9, 5),
    ).resolves.toBe(5);
  });

  it("refuses a location that is absent or inactive, without asking the doors", async () => {
    const doors = doorsThat("permit");
    const { db } = dbWithLocation(undefined);
    await expect(
      resolveLocation(draftDeps(db, doors), "org-1", "keeper-1", 9, 5),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(doors.assertLocationVisible).not.toHaveBeenCalled();
  });

  it("asks about the warehouse, not the location, when no location is named", async () => {
    // They are the same question there — the default is by construction inside
    // that warehouse — and `assertWarehouseVisible` answers it without a
    // second query.
    const doors = doorsThat("permit");
    const resolveDefaultLocationId = jest.fn(async () => 42);
    const deps = draftDeps({}, doors, { resolveDefaultLocationId });
    await expect(
      resolveLocation(deps, "org-1", "keeper-1", 9, undefined),
    ).resolves.toBe(42);
    expect(doors.assertWarehouseVisible).toHaveBeenCalledWith("org-1", "keeper-1", 9);
    expect(doors.assertLocationVisible).not.toHaveBeenCalled();
  });
});

describe("the receipt a draft edit is allowed to touch", () => {
  function dbReturningGrn(grn: unknown) {
    return { query: { invGrns: { findFirst: jest.fn(async () => grn) } } };
  }

  it.each(["POSTED", "CANCELLED", "QUALITY_REVIEW"])(
    "refuses to edit a %s receipt, whose lines have become a record of what arrived",
    async (status) => {
      const db = dbReturningGrn({ id: 3, status, locationId: 5, poId: 7 });
      await expect(
        loadEditableGrn(transitionDeps(db, doorsThat("permit")), "org-1", 3, "keeper-1"),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each(["DRAFT", "COUNTING"])("lets a %s receipt through", async (status) => {
    const db = dbReturningGrn({ id: 3, status, locationId: 5, poId: 7 });
    await expect(
      loadEditableGrn(transitionDeps(db, doorsThat("permit")), "org-1", 3, "keeper-1"),
    ).resolves.toMatchObject({ id: 3, status });
  });

  it("refuses a receipt standing at a location the caller cannot see", async () => {
    const doors = doorsThat("refuse");
    const db = dbReturningGrn({ id: 3, status: "DRAFT", locationId: 5, poId: 7 });
    await expect(
      loadEditableGrn(transitionDeps(db, doors), "org-1", 3, "keeper-1"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(doors.assertLocationVisible).toHaveBeenCalledWith("org-1", "keeper-1", 5);
  });
});

describe("the rules a receipt line has to satisfy", () => {
  const PO: ReceivablePo = {
    id: 7,
    warehouseId: 9,
    lines: [
      { id: 11, productVariant: { id: 100, productId: 200, product: { measureMode: "PIECES" } } },
      { id: 12, productVariant: { id: 101, productId: 201, product: { measureMode: "PIECES" } } },
    ],
  };

  function txStub() {
    let nextId = 500;
    const written: unknown[] = [];
    const insert = jest.fn(() => ({
      values: (v: unknown) => {
        written.push(v);
        return Object.assign(Promise.resolve(undefined), {
          returning: () => Promise.resolve([{ id: nextId++ }]),
        });
      },
    }));
    return { tx: { insert } as never, insert, written };
  }

  function line(over: Record<string, unknown> = {}) {
    return {
      poLineId: 11,
      quantityReceived: "5.0000",
      qualityStatus: "ACCEPTED",
      ...over,
    } as never;
  }

  async function run(lines: unknown[], over: Partial<GrnDraftDeps> = {}) {
    const stub = txStub();
    const deps = draftDeps({}, doorsThat("permit"), over);
    await insertGrnLines(deps, stub.tx, "org-1", 3, PO, lines as never);
    return stub;
  }

  it("writes a line that satisfies every rule", async () => {
    // The floor. Without it an `insertGrnLines` that threw unconditionally
    // would satisfy every refusal below.
    const stub = await run([line()]);
    expect(stub.insert).toHaveBeenCalledTimes(1);
  });

  it("refuses the same PO line twice on one receipt", async () => {
    // Two counts of the same ordered line is a counting error, and taking both
    // would receive the goods twice.
    await expect(run([line(), line()])).rejects.toThrow(/appears twice/);
  });

  it("refuses a line that is not on the purchase order at all", async () => {
    await expect(run([line({ poLineId: 99 })])).rejects.toThrow(/not found/);
  });

  it("refuses a rejected line with no reason, because a rejection is a claim", async () => {
    await expect(
      run([line({ qualityStatus: "REJECTED" })]),
    ).rejects.toThrow(/needs a reason/);
  });

  it("accepts a rejected line that carries one", async () => {
    const stub = await run([
      line({ qualityStatus: "REJECTED", rejectionReason: "crushed in transit" }),
    ]);
    expect(stub.insert).toHaveBeenCalledTimes(1);
  });

  it("refuses the same serial scanned twice on one line", async () => {
    // A duplicate scan and two genuinely identical serials are indistinguishable
    // here, and inventing a second unit is worse than asking the scanner again.
    await expect(
      run([line({ serialNumbers: ["S-1", "S-2", "S-1"] })]),
    ).rejects.toThrow(/scanned twice/);
  });

  it("writes the serials of a line that scanned each one once", async () => {
    const stub = await run([line({ serialNumbers: ["S-1", "S-2"] })]);
    // One insert for the line, one for its serials.
    expect(stub.insert).toHaveBeenCalledTimes(2);
  });

  it("asks the quantity-capture rule about the variant before writing anything", async () => {
    const assertEnteredQuantity = jest.fn(async () => {
      throw new BadRequestException("this SKU is weighed, not counted");
    });
    const stub = txStub();
    const deps = draftDeps({}, doorsThat("permit"), {
      quantityCapture: { assertEnteredQuantity } as never,
    });
    await expect(
      insertGrnLines(deps, stub.tx, "org-1", 3, PO, [line()] as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(assertEnteredQuantity).toHaveBeenCalledWith("org-1", 100, "5.0000");
    expect(stub.insert).not.toHaveBeenCalled();
  });

  it("asks whether a named handling unit may hold stock, before writing anything", async () => {
    const assertCanHoldStockInTx = jest.fn(async () => {
      throw new BadRequestException("that pallet is already shipped");
    });
    const stub = txStub();
    const deps = draftDeps({}, doorsThat("permit"), {
      handlingUnits: { assertCanHoldStockInTx } as never,
    });
    await expect(
      insertGrnLines(deps, stub.tx, "org-1", 3, PO, [line({ handlingUnitId: 4 })] as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(stub.insert).not.toHaveBeenCalled();
  });
});
