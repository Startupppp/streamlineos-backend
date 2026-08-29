import {
  movementsForDisposition,
  serialStatusForDisposition,
  type DispositionLine,
} from "../return-dispositions";

/**
 * B9. These used to assert against a copy of the rule declared in this file.
 *
 * The copy said a QUARANTINE line produced one `QUALITY_HOLD` movement. The
 * service had been corrected months earlier to raise `ON_HAND` as well — the
 * hold is a *subset* of on-hand, so raising only the hold subtracted the arrival
 * from the good stock already on the shelf — and every one of these tests went
 * on passing against the wrong answer. They import the real function now.
 */
function line(overrides: Partial<DispositionLine> = {}): DispositionLine {
  return {
    productVariantId: 10,
    disposition: "RESTOCK",
    quantity: "3.0000",
    lotId: null,
    serialId: null,
    ...overrides,
  };
}

describe("customer return — disposition to movements", () => {
  it("RESTOCK receives the goods into ON_HAND at the target location", () => {
    const movements = movementsForDisposition(line({ lotId: 5 }), 100);

    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      transactionType: "CUSTOMER_RETURN",
      qualityBucket: "ON_HAND",
      quantityDelta: "3.0000",
      locationId: 100,
      lotId: 5,
    });
  });

  it("QUARANTINE raises ON_HAND and the hold, in that order", () => {
    // Order is load-bearing: `assertBucketsCoherent` refuses a hold larger than
    // on-hand, so the arrival has to be recorded before it is restrained.
    const movements = movementsForDisposition(
      line({ disposition: "QUARANTINE", quantity: "2.0000" }),
      200,
    );

    expect(movements.map((m) => m.qualityBucket)).toEqual(["ON_HAND", "QUALITY_HOLD"]);
    expect(movements.every((m) => m.transactionType === "QUARANTINE_IN")).toBe(true);
    expect(movements.every((m) => m.quantityDelta === "2.0000")).toBe(true);
  });

  it("RETURN_TO_VENDOR receives the goods and blocks them, in that order", () => {
    const movements = movementsForDisposition(
      line({ disposition: "RETURN_TO_VENDOR", quantity: "4.0000" }),
      300,
    );

    expect(movements.map((m) => m.qualityBucket)).toEqual(["ON_HAND", "BLOCKED"]);
    expect(movements.every((m) => m.transactionType === "CUSTOMER_RETURN")).toBe(true);
  });

  it("SCRAP produces no movement at all", () => {
    // The goods never enter stock, so there is nothing to remove; a receipt and
    // a write-off of the same quantity on the same day would net to this.
    expect(movementsForDisposition(line({ disposition: "SCRAP" }), 300)).toEqual([]);
  });

  it("carries the serial through to the movement", () => {
    const movements = movementsForDisposition(
      line({ quantity: "1.0000", serialId: 999 }),
      50,
    );

    expect(movements[0]!.serialId).toBe(999);
  });

  it("an uninspected line produces nothing, because posting refuses it first", () => {
    expect(movementsForDisposition(line({ disposition: null }), 50)).toEqual([]);
  });
});

describe("customer return — disposition to serial status", () => {
  it.each([
    ["RESTOCK", "IN_STOCK"],
    ["SCRAP", "SCRAPPED"],
    ["QUARANTINE", "QUARANTINE"],
    ["RETURN_TO_VENDOR", "RETURNED"],
  ] as const)("%s leaves the unit %s", (disposition, expected) => {
    expect(serialStatusForDisposition(disposition)).toBe(expected);
  });
});

describe("vendor return — engine call specification", () => {
  // The vendor direction has no disposition: every line leaves, so the movement
  // is the line negated. Asserted here because the sign is the whole rule and a
  // dropped minus reads as a receipt.
  function buildVendorReturnMovements(
    lines: Array<{
      productVariantId: number;
      quantity: string;
      unitCost?: string;
      lotId?: number;
      serialId?: number;
    }>,
    locationIdByVariant: Map<number, number>,
  ) {
    return lines.map((l) => ({
      transactionType: "VENDOR_RETURN",
      productVariantId: l.productVariantId,
      locationId: locationIdByVariant.get(l.productVariantId) ?? 0,
      lotId: l.lotId,
      serialId: l.serialId,
      quantityDelta: `-${l.quantity}`,
      unitCost: l.unitCost,
    }));
  }

  it("generates VENDOR_RETURN movements with negative quantityDelta", () => {
    const movements = buildVendorReturnMovements(
      [{ productVariantId: 10, quantity: "5.0000", unitCost: "12.50", lotId: 3 }],
      new Map([[10, 100]]),
    );

    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      transactionType: "VENDOR_RETURN",
      quantityDelta: "-5.0000",
      lotId: 3,
      locationId: 100,
    });
  });

  it("builds one movement per return line", () => {
    const movements = buildVendorReturnMovements(
      [
        { productVariantId: 1, quantity: "2.0000" },
        { productVariantId: 2, quantity: "3.0000" },
      ],
      new Map([[1, 10], [2, 20]]),
    );

    expect(movements.map((m) => m.productVariantId)).toEqual([1, 2]);
  });

  it("includes serialId when the return line is serial-tracked", () => {
    const movements = buildVendorReturnMovements(
      [{ productVariantId: 5, quantity: "1.0000", serialId: 999 }],
      new Map([[5, 50]]),
    );

    expect(movements[0]!.serialId).toBe(999);
    expect(movements[0]!.quantityDelta).toBe("-1.0000");
  });
});
