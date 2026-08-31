import {
  checkCompatibility,
  nextRolloutAction,
  rollbackPlan,
  shouldRollBack,
} from "./canary-rollout";
import type { Release, RolloutPlan, SloSnapshot } from "./canary-rollout";

function release(overrides: Partial<Release> = {}): Release {
  return {
    releaseId: "v1.2.3",
    schemaVersion: 5,
    eventVersion: 3,
    minSchemaVersion: 4,
    minEventVersion: 2,
    ...overrides,
  };
}

function plan(overrides: Partial<{ cells: readonly [string, ...string[]] }> = {}): RolloutPlan {
  return {
    release: release(),
    canaryCellId: "canary-cell",
    orderedCells: overrides.cells ?? ["canary-cell", "cell-2", "cell-3"],
  };
}

function goodSlo(): SloSnapshot {
  return { errorRatePercent: 0.1, p99LatencyMs: 100, availabilityPercent: 99.9 };
}

function badSlo(): SloSnapshot {
  return { errorRatePercent: 5.0, p99LatencyMs: 1_500, availabilityPercent: 95.0 };
}

describe("checkCompatibility", () => {
  it("passes when the release can serve all running schema and event versions", () => {
    const result = checkCompatibility(release(), 4, 2);
    expect(result.compatible).toBe(true);
  });

  it("passes when running versions match the release minimums exactly", () => {
    const result = checkCompatibility(release({ minSchemaVersion: 4, minEventVersion: 2 }), 4, 2);
    expect(result.compatible).toBe(true);
  });

  it("refuses when the oldest schema version is below the release minimum", () => {
    const result = checkCompatibility(release({ minSchemaVersion: 5 }), 4, 2);
    expect(result.compatible).toBe(false);
    if (!result.compatible) expect(result.reason).toMatch(/schema/);
  });

  it("refuses when the oldest event version is below the release minimum", () => {
    const result = checkCompatibility(release({ minEventVersion: 4 }), 4, 3);
    expect(result.compatible).toBe(false);
    if (!result.compatible) expect(result.reason).toMatch(/event/);
  });
});

describe("shouldRollBack", () => {
  it("does not roll back when SLO is unchanged", () => {
    expect(shouldRollBack(goodSlo(), goodSlo())).toBe(false);
  });

  it("does not roll back when SLO improves", () => {
    const improved: SloSnapshot = { errorRatePercent: 0.05, p99LatencyMs: 80, availabilityPercent: 99.95 };
    expect(shouldRollBack(goodSlo(), improved)).toBe(false);
  });

  it("triggers rollback when error rate increases significantly", () => {
    const degraded: SloSnapshot = { ...goodSlo(), errorRatePercent: 3.0 };
    expect(shouldRollBack(goodSlo(), degraded)).toBe(true);
  });

  it("triggers rollback when latency increases significantly", () => {
    const degraded: SloSnapshot = { ...goodSlo(), p99LatencyMs: 500 };
    expect(shouldRollBack(goodSlo(), degraded)).toBe(true);
  });

  it("triggers rollback when availability drops significantly", () => {
    const degraded: SloSnapshot = { ...goodSlo(), availabilityPercent: 98.5 };
    expect(shouldRollBack(goodSlo(), degraded)).toBe(true);
  });

  it("deliberately regresses a canary and confirms rollback fires", () => {
    expect(shouldRollBack(goodSlo(), badSlo())).toBe(true);
  });
});

describe("nextRolloutAction", () => {
  it("starts with the canary cell when nothing is deployed", () => {
    const action = nextRolloutAction(plan(), [], true);
    expect(action.kind).toBe("DEPLOY");
    if (action.kind === "DEPLOY") expect(action.cellId).toBe("canary-cell");
  });

  it("does not proceed before canary SLO passes", () => {
    const action = nextRolloutAction(plan(), ["canary-cell"], false);
    expect(action.kind).toBe("ROLLBACK");
    if (action.kind === "ROLLBACK") expect(action.cellId).toBe("canary-cell");
  });

  it("rolls back the canary when SLO regresses — the canary, not the next cell", () => {
    const action = nextRolloutAction(plan(), ["canary-cell"], false);
    expect(action.kind).toBe("ROLLBACK");
    if (action.kind === "ROLLBACK") expect(action.cellId).not.toBe("cell-2");
  });

  it("proceeds to cell-2 after canary passes SLO", () => {
    const action = nextRolloutAction(plan(), ["canary-cell"], true);
    expect(action.kind).toBe("DEPLOY");
    if (action.kind === "DEPLOY") expect(action.cellId).toBe("cell-2");
  });

  it("proceeds to cell-3 after cell-2 passes SLO", () => {
    const action = nextRolloutAction(plan(), ["canary-cell", "cell-2"], true);
    expect(action.kind).toBe("DEPLOY");
    if (action.kind === "DEPLOY") expect(action.cellId).toBe("cell-3");
  });

  it("completes when all cells pass SLO", () => {
    const action = nextRolloutAction(plan(), ["canary-cell", "cell-2", "cell-3"], true);
    expect(action.kind).toBe("COMPLETE");
  });

  it("rolls back cell-2 if it regresses, not cell-3 or beyond", () => {
    const action = nextRolloutAction(plan(), ["canary-cell", "cell-2"], false);
    expect(action.kind).toBe("ROLLBACK");
    if (action.kind === "ROLLBACK") {
      expect(action.cellId).toBe("cell-2");
      expect(action.cellId).not.toBe("cell-3");
    }
  });
});

describe("rollbackPlan", () => {
  it("includes cells that were deployed in the rollback list", () => {
    const rp = rollbackPlan(plan(), ["canary-cell", "cell-2"], "v1.2.2");
    expect(rp.cellsToRevert).toContain("canary-cell");
    expect(rp.cellsToRevert).toContain("cell-2");
  });

  it("excludes cells that were not yet deployed", () => {
    const rp = rollbackPlan(plan(), ["canary-cell"], "v1.2.2");
    expect(rp.cellsToRevert).not.toContain("cell-2");
    expect(rp.cellsToRevert).not.toContain("cell-3");
  });

  it("carries the release id and previous release id for audit", () => {
    const rp = rollbackPlan(plan(), ["canary-cell"], "v1.2.2");
    expect(rp.releaseId).toBe("v1.2.3");
    expect(rp.previousReleaseId).toBe("v1.2.2");
  });

  it("accepts null previous release when no prior release exists", () => {
    const rp = rollbackPlan(plan(), ["canary-cell"], null);
    expect(rp.previousReleaseId).toBeNull();
  });
});
