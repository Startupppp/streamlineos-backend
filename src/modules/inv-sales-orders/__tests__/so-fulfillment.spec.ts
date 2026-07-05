interface LotRow { id: number; expiryDate: string | null; status: string; }
interface LevelRow {
  locationId: number;
  lotId: number | null;
  onHand: string;
  committed: string;
  blockedQty: string;
  qualityHoldQty: string;
}

function selectLot(
  levels: LevelRow[],
  lots: LotRow[],
  qty: number,
  strategy: string,
  expiryPolicy: string,
  today: string,
): { locationId: number; lotId?: number } | null {
  const filtered = levels.filter((l) => {
    const avail = parseFloat(l.onHand) - parseFloat(l.committed)
      - parseFloat(l.blockedQty) - parseFloat(l.qualityHoldQty);
    return avail >= qty;
  });

  if (filtered.length === 0) return null;

  if (strategy === "FEFO" && filtered.some((l) => l.lotId !== null)) {
    const sorted = [...lots].sort((a, b) => {
      if (!a.expiryDate) return 1;
      if (!b.expiryDate) return -1;
      return a.expiryDate < b.expiryDate ? -1 : 1;
    });
    for (const lot of sorted) {
      if (lot.status !== "ACTIVE") continue;
      if (expiryPolicy === "BLOCK" && lot.expiryDate && lot.expiryDate <= today) continue;
      const match = filtered.find((l) => l.lotId === lot.id);
      if (match) return { locationId: match.locationId, lotId: lot.id };
    }
    if (expiryPolicy === "BLOCK") return null;
  }

  if (strategy === "FIFO" && filtered.some((l) => l.lotId !== null)) {
    const sorted = [...filtered].sort((a, b) => (a.lotId ?? 0) - (b.lotId ?? 0));
    const match = sorted.find((l) => l.lotId !== null);
    if (match) return { locationId: match.locationId, lotId: match.lotId ?? undefined };
  }

  const first = filtered[0];
  if (!first) return null;
  return { locationId: first.locationId, lotId: first.lotId ?? undefined };
}

const LEVEL_FULL = (locationId: number, lotId: number | null, onHand: string): LevelRow => ({
  locationId,
  lotId,
  onHand,
  committed: "0",
  blockedQty: "0",
  qualityHoldQty: "0",
});

describe("Lot selection — FEFO", () => {
  const TODAY = "2026-07-05";

  it("selects lot with earliest expiry date", () => {
    const levels = [
      LEVEL_FULL(1, 10, "50"),
      LEVEL_FULL(2, 20, "50"),
    ];
    const lots: LotRow[] = [
      { id: 10, expiryDate: "2026-12-01", status: "ACTIVE" },
      { id: 20, expiryDate: "2026-08-01", status: "ACTIVE" },
    ];
    const result = selectLot(levels, lots, 10, "FEFO", "WARN", TODAY);
    expect(result?.lotId).toBe(20);
    expect(result?.locationId).toBe(2);
  });

  it("skips expired lots under BLOCK policy", () => {
    const levels = [
      LEVEL_FULL(1, 10, "50"),
      LEVEL_FULL(2, 20, "50"),
    ];
    const lots: LotRow[] = [
      { id: 10, expiryDate: "2026-07-01", status: "ACTIVE" },
      { id: 20, expiryDate: "2027-01-01", status: "ACTIVE" },
    ];
    const result = selectLot(levels, lots, 10, "FEFO", "BLOCK", TODAY);
    expect(result?.lotId).toBe(20);
  });

  it("returns expired lot under WARN policy (not blocked)", () => {
    const levels = [LEVEL_FULL(1, 10, "50")];
    const lots: LotRow[] = [{ id: 10, expiryDate: "2026-07-01", status: "ACTIVE" }];
    const result = selectLot(levels, lots, 10, "FEFO", "WARN", TODAY);
    expect(result?.lotId).toBe(10);
  });

  it("skips inactive lots", () => {
    const levels = [
      LEVEL_FULL(1, 10, "50"),
      LEVEL_FULL(2, 20, "50"),
    ];
    const lots: LotRow[] = [
      { id: 10, expiryDate: "2026-08-01", status: "RECALLED" },
      { id: 20, expiryDate: "2026-12-01", status: "ACTIVE" },
    ];
    const result = selectLot(levels, lots, 10, "FEFO", "BLOCK", TODAY);
    expect(result?.lotId).toBe(20);
  });

  it("returns null when all lots are expired under BLOCK policy", () => {
    const levels = [LEVEL_FULL(1, 10, "50")];
    const lots: LotRow[] = [{ id: 10, expiryDate: "2026-01-01", status: "ACTIVE" }];
    const result = selectLot(levels, lots, 10, "FEFO", "BLOCK", TODAY);
    expect(result).toBeNull();
  });
});

describe("Lot selection — FIFO", () => {
  it("selects lot with smallest id (oldest created)", () => {
    const levels = [
      LEVEL_FULL(1, 30, "50"),
      LEVEL_FULL(2, 10, "50"),
      LEVEL_FULL(3, 20, "50"),
    ];
    const lots: LotRow[] = [
      { id: 10, expiryDate: null, status: "ACTIVE" },
      { id: 20, expiryDate: null, status: "ACTIVE" },
      { id: 30, expiryDate: null, status: "ACTIVE" },
    ];
    const result = selectLot(levels, lots, 10, "FIFO", "WARN", "2026-07-05");
    expect(result?.lotId).toBe(10);
    expect(result?.locationId).toBe(2);
  });

  it("skips levels with insufficient available stock", () => {
    const levels = [
      { locationId: 1, lotId: 5, onHand: "5", committed: "5", blockedQty: "0", qualityHoldQty: "0" },
      { locationId: 2, lotId: 10, onHand: "50", committed: "0", blockedQty: "0", qualityHoldQty: "0" },
    ];
    const lots: LotRow[] = [
      { id: 5, expiryDate: null, status: "ACTIVE" },
      { id: 10, expiryDate: null, status: "ACTIVE" },
    ];
    const result = selectLot(levels, lots, 20, "FIFO", "WARN", "2026-07-05");
    expect(result?.lotId).toBe(10);
  });
});

describe("Lot selection — fallback to any available", () => {
  it("returns first available level when strategy is MANUAL", () => {
    const levels = [LEVEL_FULL(5, null, "100")];
    const lots: LotRow[] = [];
    const result = selectLot(levels, lots, 10, "MANUAL", "WARN", "2026-07-05");
    expect(result?.locationId).toBe(5);
    expect(result?.lotId).toBeUndefined();
  });

  it("returns null when no levels have sufficient stock", () => {
    const levels = [
      { locationId: 1, lotId: null, onHand: "5", committed: "5", blockedQty: "0", qualityHoldQty: "0" },
    ];
    const result = selectLot(levels, [], 10, "FIFO", "WARN", "2026-07-05");
    expect(result).toBeNull();
  });
});

describe("Partial shipment status computation", () => {
  function computeShipStatus(
    orderedQty: number,
    shippedQty: number,
  ): "SHIPPED" | "PARTIALLY_SHIPPED" {
    return shippedQty < orderedQty ? "PARTIALLY_SHIPPED" : "SHIPPED";
  }

  it("is SHIPPED when shipped qty equals ordered qty", () => {
    expect(computeShipStatus(100, 100)).toBe("SHIPPED");
  });

  it("is PARTIALLY_SHIPPED when shipped qty is less than ordered qty", () => {
    expect(computeShipStatus(100, 75)).toBe("PARTIALLY_SHIPPED");
  });

  it("is PARTIALLY_SHIPPED even when shipped qty is 1 unit short", () => {
    expect(computeShipStatus(10, 9)).toBe("PARTIALLY_SHIPPED");
  });

  it("is SHIPPED when ordered single unit and shipped single unit", () => {
    expect(computeShipStatus(1, 1)).toBe("SHIPPED");
  });

  it("handles fractional quantities — PARTIALLY_SHIPPED", () => {
    expect(computeShipStatus(10.5, 10.4)).toBe("PARTIALLY_SHIPPED");
  });

  it("handles fractional quantities — exact match = SHIPPED", () => {
    expect(computeShipStatus(10.5, 10.5)).toBe("SHIPPED");
  });
});

describe("pickSo — serial validation", () => {
  function validatePickLines(
    pickLines: Array<{ soLineId: number; serialId?: number }>,
    soLines: Array<{ id: number; trackingMethod: string }>,
  ): string | null {
    for (const pickLine of pickLines) {
      const soLine = soLines.find((l) => l.id === pickLine.soLineId);
      if (!soLine) return `SO line ${pickLine.soLineId} not found`;
      if (soLine.trackingMethod === "SERIAL" && !pickLine.serialId) {
        return `SO line ${pickLine.soLineId}: SERIAL-tracked product requires serialId per unit`;
      }
    }
    return null;
  }

  it("passes when all SERIAL lines have serialId", () => {
    const result = validatePickLines(
      [{ soLineId: 1, serialId: 101 }],
      [{ id: 1, trackingMethod: "SERIAL" }],
    );
    expect(result).toBeNull();
  });

  it("rejects when SERIAL line is missing serialId", () => {
    const result = validatePickLines(
      [{ soLineId: 1 }],
      [{ id: 1, trackingMethod: "SERIAL" }],
    );
    expect(result).toMatch(/SERIAL-tracked/);
    expect(result).toMatch(/serialId/);
  });

  it("passes for LOT-tracked line without serialId", () => {
    const result = validatePickLines(
      [{ soLineId: 2 }],
      [{ id: 2, trackingMethod: "LOT" }],
    );
    expect(result).toBeNull();
  });

  it("passes for NONE-tracked line without serialId", () => {
    const result = validatePickLines(
      [{ soLineId: 3 }],
      [{ id: 3, trackingMethod: "NONE" }],
    );
    expect(result).toBeNull();
  });

  it("returns error referencing the specific SO line id", () => {
    const result = validatePickLines(
      [{ soLineId: 99 }],
      [{ id: 99, trackingMethod: "SERIAL" }],
    );
    expect(result).toMatch(/99/);
  });
});
