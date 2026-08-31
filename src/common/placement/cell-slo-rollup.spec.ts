import { rollupSlo } from "./cell-slo-rollup";
import type { CellSloMeasurement, SloThresholds } from "./cell-slo-rollup";

const THRESHOLDS: SloThresholds = {
  maxP99LatencyMs: 500,
  maxErrorRatePercent: 1.0,
  minAvailabilityPercent: 99.0,
};

function measurement(
  cellId: string,
  overrides: Partial<Omit<CellSloMeasurement, "cellId">> = {},
): CellSloMeasurement {
  return {
    cellId,
    p99LatencyMs: 100,
    errorRatePercent: 0.1,
    availabilityPercent: 99.9,
    ...overrides,
  };
}

function breachingMeasurement(cellId: string): CellSloMeasurement {
  return measurement(cellId, { errorRatePercent: 10, p99LatencyMs: 2_000, availabilityPercent: 90 });
}

describe("rollupSlo", () => {
  it("reports healthy when all cells are within thresholds", () => {
    const result = rollupSlo(
      [measurement("cell-1"), measurement("cell-2")],
      THRESHOLDS,
    );
    expect(result.healthy).toBe(true);
  });

  it("reports unhealthy when any cell breaches a threshold", () => {
    const result = rollupSlo(
      [measurement("cell-1"), breachingMeasurement("cell-bad")],
      THRESHOLDS,
    );
    expect(result.healthy).toBe(false);
  });

  it("nine healthy cells plus one breaching cell reports as breaching, not as a healthy average", () => {
    const cells: [CellSloMeasurement, ...CellSloMeasurement[]] = [
      measurement("cell-1"),
      measurement("cell-2"),
      measurement("cell-3"),
      measurement("cell-4"),
      measurement("cell-5"),
      measurement("cell-6"),
      measurement("cell-7"),
      measurement("cell-8"),
      measurement("cell-9"),
      breachingMeasurement("cell-bad"),
    ];
    const result = rollupSlo(cells, THRESHOLDS);
    expect(result.healthy).toBe(false);
  });

  it("always includes a worstCell in the rollup", () => {
    const result = rollupSlo([measurement("cell-1")], THRESHOLDS);
    expect(result.worstCell).toBeDefined();
    expect(result.worstCell.cellId).toBe("cell-1");
  });

  it("sets worstCell to the unhealthy cell when one exists among healthy cells", () => {
    const result = rollupSlo(
      [measurement("cell-1"), breachingMeasurement("cell-bad"), measurement("cell-2")],
      THRESHOLDS,
    );
    expect(result.worstCell.cellId).toBe("cell-bad");
    expect(result.worstCell.healthy).toBe(false);
  });

  it("includes per-cell status for every cell in the breakdown", () => {
    const result = rollupSlo(
      [measurement("cell-1"), measurement("cell-2"), breachingMeasurement("cell-3")],
      THRESHOLDS,
    );
    expect(result.cells.length).toBe(3);
    const ids = result.cells.map((c) => c.cellId);
    expect(ids).toContain("cell-1");
    expect(ids).toContain("cell-2");
    expect(ids).toContain("cell-3");
  });

  it("marks a cell unhealthy when p99 latency exceeds the threshold", () => {
    const result = rollupSlo(
      [measurement("cell-1", { p99LatencyMs: 600 })],
      THRESHOLDS,
    );
    expect(result.healthy).toBe(false);
    expect(result.worstCell.healthy).toBe(false);
  });

  it("marks a cell unhealthy when availability drops below the threshold", () => {
    const result = rollupSlo(
      [measurement("cell-1", { availabilityPercent: 98.0 })],
      THRESHOLDS,
    );
    expect(result.healthy).toBe(false);
  });

  it("keeps per-cell measurement in the status for auditability", () => {
    const m = measurement("cell-1");
    const result = rollupSlo([m], THRESHOLDS);
    expect(result.cells[0]?.measurement).toEqual(m);
  });
});
