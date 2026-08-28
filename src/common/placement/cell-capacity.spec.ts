import {
  ADMISSION_THRESHOLD,
  admits,
  headroomOrganizations,
  saturationForecast,
  utilisationRatio,
} from "./cell-capacity";
import type { CellUtilisation } from "./cell-capacity";

function cell(used: number, limit: number, measuredAt = 0): CellUtilisation {
  return { cellId: "cell-1", limitingResource: "cpu", used, limit, measuredAt };
}

describe("utilisationRatio", () => {
  it("computes used divided by limit", () => {
    expect(utilisationRatio(cell(30, 100))).toBeCloseTo(0.3);
  });

  it("returns 1.0 when fully utilized", () => {
    expect(utilisationRatio(cell(100, 100))).toBe(1.0);
  });
});

describe("admits", () => {
  it("admits a cell strictly below ADMISSION_THRESHOLD", () => {
    expect(admits(cell(59, 100))).toBe(true);
  });

  it("does not admit a cell at exactly ADMISSION_THRESHOLD", () => {
    expect(admits(cell(60, 100))).toBe(false);
    expect(utilisationRatio(cell(60, 100))).toBe(ADMISSION_THRESHOLD);
  });

  it("does not admit a cell above ADMISSION_THRESHOLD", () => {
    expect(admits(cell(80, 100))).toBe(false);
  });
});

describe("headroomOrganizations", () => {
  it("returns how many orgs can be placed before the admission threshold", () => {
    expect(headroomOrganizations(cell(30, 100), 10)).toBe(3);
  });

  it("returns 0 when already at or above the threshold", () => {
    expect(headroomOrganizations(cell(60, 100), 10)).toBe(0);
    expect(headroomOrganizations(cell(80, 100), 10)).toBe(0);
  });

  it("returns 0 when perOrgCost is zero", () => {
    expect(headroomOrganizations(cell(10, 100), 0)).toBe(0);
  });
});

describe("saturationForecast", () => {
  it("refuses when fewer than 2 samples are provided", () => {
    const result = saturationForecast([cell(30, 100, 1_000)], 0);
    expect(result.forecastable).toBe(false);
    if (!result.forecastable) expect(result.reason).toMatch(/insufficient/);
  });

  it("refuses when no samples are provided", () => {
    const result = saturationForecast([], 0);
    expect(result.forecastable).toBe(false);
  });

  it("refuses when the trend is flat", () => {
    const history = [cell(30, 100, 1_000), cell(30, 100, 2_000)];
    const result = saturationForecast(history, 0);
    expect(result.forecastable).toBe(false);
    if (!result.forecastable) expect(result.reason).toMatch(/flat or negative/);
  });

  it("refuses when the trend is negative (usage declining)", () => {
    const history = [cell(50, 100, 1_000), cell(30, 100, 2_000)];
    const result = saturationForecast(history, 0);
    expect(result.forecastable).toBe(false);
    if (!result.forecastable) expect(result.reason).toMatch(/flat or negative/);
  });

  it("projects a future timestamp when the trend is positive", () => {
    const history = [
      cell(20, 100, 0),
      cell(40, 100, 1_000),
      cell(60, 100, 2_000),
    ];
    const result = saturationForecast(history, 0);
    expect(result.forecastable).toBe(true);
    if (result.forecastable) {
      expect(result.projectedAt).toBeGreaterThan(2_000);
      expect(result.projectedRatio).toBe(1.0);
    }
  });

  it("forecasts sooner when perOrgCost shifts the current ratio higher", () => {
    const history = [cell(20, 100, 0), cell(40, 100, 1_000)];
    const noOrg = saturationForecast(history, 0);
    const withOrg = saturationForecast(history, 20);
    expect(noOrg.forecastable).toBe(true);
    expect(withOrg.forecastable).toBe(true);
    if (noOrg.forecastable && withOrg.forecastable)
      expect(withOrg.projectedAt).toBeLessThan(noOrg.projectedAt);
  });

  it("refuses when perOrgCost already pushes the cell past saturation", () => {
    const history = [cell(80, 100, 0), cell(90, 100, 1_000)];
    const result = saturationForecast(history, 20);
    expect(result.forecastable).toBe(false);
  });
});
