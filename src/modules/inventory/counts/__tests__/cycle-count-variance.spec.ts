describe("Cycle count variance computation", () => {
  function computeVariance(systemQty: number, countedQty: number): number {
    return countedQty - systemQty;
  }

  function classifyMovement(variance: number): "CYCLE_COUNT_GAIN" | "CYCLE_COUNT_LOSS" | null {
    if (variance > 0) return "CYCLE_COUNT_GAIN";
    if (variance < 0) return "CYCLE_COUNT_LOSS";
    return null;
  }

  function buildMovements(lines: Array<{ systemQty: number; countedQty: number; productVariantId: number; locationId: number }>) {
    return lines
      .map((l) => {
        const variance = computeVariance(l.systemQty, l.countedQty);
        const txType = classifyMovement(variance);
        if (!txType) return null;
        return {
          transactionType: txType,
          productVariantId: l.productVariantId,
          locationId: l.locationId,
          quantityDelta: variance.toFixed(4),
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
  }

  describe("variance = countedQty - systemQty", () => {
    it("returns positive variance when more found than expected", () => {
      expect(computeVariance(10, 15)).toBe(5);
    });

    it("returns negative variance when less found than expected", () => {
      expect(computeVariance(20, 12)).toBe(-8);
    });

    it("returns zero variance when counts match", () => {
      expect(computeVariance(5, 5)).toBe(0);
    });

    it("handles fractional quantities", () => {
      expect(computeVariance(1.5, 2.25)).toBeCloseTo(0.75);
    });
  });

  describe("movement classification", () => {
    it("positive variance → CYCLE_COUNT_GAIN", () => {
      expect(classifyMovement(5)).toBe("CYCLE_COUNT_GAIN");
    });

    it("negative variance → CYCLE_COUNT_LOSS", () => {
      expect(classifyMovement(-3)).toBe("CYCLE_COUNT_LOSS");
    });

    it("zero variance → null (no movement generated)", () => {
      expect(classifyMovement(0)).toBeNull();
    });
  });

  describe("movement building — zero-variance lines are excluded", () => {
    it("excludes lines where counted equals system", () => {
      const lines = [
        { systemQty: 10, countedQty: 10, productVariantId: 1, locationId: 1 },
        { systemQty: 5, countedQty: 8, productVariantId: 2, locationId: 1 },
      ];
      const movements = buildMovements(lines);
      expect(movements).toHaveLength(1);
      expect(movements[0].transactionType).toBe("CYCLE_COUNT_GAIN");
    });

    it("all zero-variance → empty movements array", () => {
      const lines = [
        { systemQty: 10, countedQty: 10, productVariantId: 1, locationId: 1 },
      ];
      expect(buildMovements(lines)).toHaveLength(0);
    });

    it("mixed gain/loss lines produce correct movement types", () => {
      const lines = [
        { systemQty: 10, countedQty: 15, productVariantId: 1, locationId: 1 },
        { systemQty: 20, countedQty: 18, productVariantId: 2, locationId: 1 },
        { systemQty: 5, countedQty: 5, productVariantId: 3, locationId: 1 },
      ];
      const movements = buildMovements(lines);
      expect(movements).toHaveLength(2);
      expect(movements.find((m) => m.productVariantId === 1)?.transactionType).toBe("CYCLE_COUNT_GAIN");
      expect(movements.find((m) => m.productVariantId === 2)?.transactionType).toBe("CYCLE_COUNT_LOSS");
    });

    it("quantityDelta is negative string for CYCLE_COUNT_LOSS", () => {
      const lines = [{ systemQty: 10, countedQty: 7, productVariantId: 1, locationId: 1 }];
      const [m] = buildMovements(lines);
      expect(parseFloat(m.quantityDelta)).toBe(-3);
    });
  });
});
