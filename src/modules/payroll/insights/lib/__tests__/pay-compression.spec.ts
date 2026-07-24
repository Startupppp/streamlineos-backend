import { analyzePayCompression } from "../pay-compression";

describe("analyzePayCompression", () => {
  it("returns empty stats for no CTCs", () => {
    const r = analyzePayCompression([], 3);
    expect(r.sampleSize).toBe(0);
    expect(r.missingCtcCount).toBe(3);
    expect(r.stats.compressionRatio).toBeNull();
    expect(r.honestyNote.toLowerCase()).toMatch(/no protected attributes/);
  });

  it("computes min max median and ratio", () => {
    const r = analyzePayCompression([
      { userId: "a", annualCtc: 100 },
      { userId: "b", annualCtc: 200 },
      { userId: "c", annualCtc: 300 },
      { userId: "d", annualCtc: 400 },
    ]);
    expect(r.sampleSize).toBe(4);
    expect(r.stats.min).toBe("100.00");
    expect(r.stats.max).toBe("400.00");
    expect(r.stats.median).toBe("250.00");
    expect(r.stats.compressionRatio).toBe("4.00");
  });

  it("flags outliers above 1.5×p75 when n≥4", () => {
    const r = analyzePayCompression([
      { userId: "a", annualCtc: 100, label: "A" },
      { userId: "b", annualCtc: 110, label: "B" },
      { userId: "c", annualCtc: 120, label: "C" },
      { userId: "d", annualCtc: 500, label: "D" },
    ]);
    expect(r.outliers.some((o) => o.userId === "d" && o.side === "above")).toBe(true);
  });
});
