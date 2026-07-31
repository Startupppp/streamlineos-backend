describe("Vendor return — engine call specification", () => {
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
    return lines.map((line) => ({
      transactionType: "VENDOR_RETURN",
      productVariantId: line.productVariantId,
      locationId: locationIdByVariant.get(line.productVariantId) ?? 0,
      lotId: line.lotId,
      serialId: line.serialId,
      quantityDelta: `-${line.quantity}`,
      unitCost: line.unitCost,
    }));
  }

  it("generates VENDOR_RETURN movements with negative quantityDelta", () => {
    const movements = buildVendorReturnMovements(
      [{ productVariantId: 10, quantity: "5.0000", unitCost: "12.50", lotId: 3 }],
      new Map([[10, 100]]),
    );

    expect(movements).toHaveLength(1);
    const mv = movements[0];
    expect(mv.transactionType).toBe("VENDOR_RETURN");
    expect(mv.quantityDelta).toBe("-5.0000");
    expect(mv.lotId).toBe(3);
    expect(mv.locationId).toBe(100);
  });

  it("builds one movement per return line", () => {
    const movements = buildVendorReturnMovements(
      [
        { productVariantId: 1, quantity: "2.0000" },
        { productVariantId: 2, quantity: "3.0000" },
      ],
      new Map([[1, 10], [2, 20]]),
    );

    expect(movements).toHaveLength(2);
    expect(movements[0].productVariantId).toBe(1);
    expect(movements[1].productVariantId).toBe(2);
  });

  it("includes serialId when the return line is serial-tracked", () => {
    const movements = buildVendorReturnMovements(
      [{ productVariantId: 5, quantity: "1.0000", serialId: 999 }],
      new Map([[5, 50]]),
    );

    expect(movements[0].serialId).toBe(999);
    expect(movements[0].quantityDelta).toBe("-1.0000");
  });
});

describe("Customer return — disposition-based movement rules", () => {
  type Disposition = "RESTOCK" | "QUARANTINE" | "SCRAP";

  interface ReturnLine {
    productVariantId: number;
    quantity: string;
    disposition: Disposition;
    lotId?: number;
    serialId?: number;
  }

  interface EngineMovement {
    transactionType: string;
    productVariantId: number;
    locationId: number;
    quantityDelta: string;
    qualityBucket?: string;
    lotId?: number;
    serialId?: number;
  }

  function buildCustomerReturnMovements(
    lines: ReturnLine[],
    targetLocationId: number,
  ): EngineMovement[] {
    const movements: EngineMovement[] = [];
    for (const line of lines) {
      if (line.disposition === "SCRAP") continue;

      if (line.disposition === "RESTOCK") {
        movements.push({
          transactionType: "CUSTOMER_RETURN",
          productVariantId: line.productVariantId,
          locationId: targetLocationId,
          quantityDelta: line.quantity,
          qualityBucket: "ON_HAND",
          lotId: line.lotId,
          serialId: line.serialId,
        });
      } else if (line.disposition === "QUARANTINE") {
        movements.push({
          transactionType: "QUARANTINE_IN",
          productVariantId: line.productVariantId,
          locationId: targetLocationId,
          quantityDelta: line.quantity,
          qualityBucket: "QUALITY_HOLD",
          lotId: line.lotId,
          serialId: line.serialId,
        });
      }
    }
    return movements;
  }

  function computeSerialStatusAfterReturn(
    lines: ReturnLine[],
  ): Map<number, string> {
    const statusMap = new Map<number, string>();
    for (const line of lines) {
      if (line.serialId === undefined) continue;
      if (line.disposition === "RESTOCK") statusMap.set(line.serialId, "IN_STOCK");
      else if (line.disposition === "SCRAP") statusMap.set(line.serialId, "SCRAPPED");
      else if (line.disposition === "QUARANTINE") statusMap.set(line.serialId, "QUARANTINE");
    }
    return statusMap;
  }

  it("RESTOCK creates CUSTOMER_RETURN movement with ON_HAND bucket", () => {
    const movements = buildCustomerReturnMovements(
      [{ productVariantId: 10, quantity: "3.0000", disposition: "RESTOCK", lotId: 5 }],
      100,
    );

    expect(movements).toHaveLength(1);
    const mv = movements[0];
    expect(mv.transactionType).toBe("CUSTOMER_RETURN");
    expect(mv.qualityBucket).toBe("ON_HAND");
    expect(mv.quantityDelta).toBe("3.0000");
    expect(mv.lotId).toBe(5);
  });

  it("QUARANTINE creates QUARANTINE_IN movement with QUALITY_HOLD bucket", () => {
    const movements = buildCustomerReturnMovements(
      [{ productVariantId: 20, quantity: "2.0000", disposition: "QUARANTINE" }],
      200,
    );

    expect(movements).toHaveLength(1);
    const mv = movements[0];
    expect(mv.transactionType).toBe("QUARANTINE_IN");
    expect(mv.qualityBucket).toBe("QUALITY_HOLD");
  });

  it("SCRAP produces no stock movement", () => {
    const movements = buildCustomerReturnMovements(
      [{ productVariantId: 30, quantity: "1.0000", disposition: "SCRAP" }],
      300,
    );

    expect(movements).toHaveLength(0);
  });

  it("mixed dispositions produce correct movements per line", () => {
    const movements = buildCustomerReturnMovements(
      [
        { productVariantId: 1, quantity: "5.0000", disposition: "RESTOCK" },
        { productVariantId: 2, quantity: "2.0000", disposition: "QUARANTINE" },
        { productVariantId: 3, quantity: "1.0000", disposition: "SCRAP" },
      ],
      50,
    );

    expect(movements).toHaveLength(2);
    expect(movements[0].transactionType).toBe("CUSTOMER_RETURN");
    expect(movements[1].transactionType).toBe("QUARANTINE_IN");
  });

  it("RESTOCK sets serial status to IN_STOCK", () => {
    const statusMap = computeSerialStatusAfterReturn([
      { productVariantId: 1, quantity: "1.0000", disposition: "RESTOCK", serialId: 101 },
    ]);

    expect(statusMap.get(101)).toBe("IN_STOCK");
  });

  it("SCRAP sets serial status to SCRAPPED with no stock movement", () => {
    const movements = buildCustomerReturnMovements(
      [{ productVariantId: 1, quantity: "1.0000", disposition: "SCRAP", serialId: 202 }],
      50,
    );
    const statusMap = computeSerialStatusAfterReturn([
      { productVariantId: 1, quantity: "1.0000", disposition: "SCRAP", serialId: 202 },
    ]);

    expect(movements).toHaveLength(0);
    expect(statusMap.get(202)).toBe("SCRAPPED");
  });

  it("QUARANTINE sets serial status to QUARANTINE", () => {
    const statusMap = computeSerialStatusAfterReturn([
      { productVariantId: 1, quantity: "1.0000", disposition: "QUARANTINE", serialId: 303 },
    ]);

    expect(statusMap.get(303)).toBe("QUARANTINE");
  });

  it("lines without serialId are not included in the status map", () => {
    const statusMap = computeSerialStatusAfterReturn([
      { productVariantId: 1, quantity: "10.0000", disposition: "RESTOCK" },
    ]);

    expect(statusMap.size).toBe(0);
  });
});
