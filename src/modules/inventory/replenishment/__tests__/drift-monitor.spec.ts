import {
  DEFAULT_MAE_RATIO_THRESHOLD,
  ageInDays,
  breachesMaeThreshold,
  isStaleVersion,
} from "../forecast/drift-thresholds";
import { DriftMonitorService } from "../forecast/drift-monitor.service";

/**
 * C7 — the two judgements the watchlist makes, and the one guarantee it gives.
 */
describe("C7 MAE threshold", () => {
  it("calls a forecast whose average error matches a week's demand a breach", () => {
    expect(breachesMaeThreshold("1.0000", DEFAULT_MAE_RATIO_THRESHOLD)).toBe(true);
  });

  it("leaves a forecast comfortably inside the threshold alone", () => {
    expect(breachesMaeThreshold("0.3200", DEFAULT_MAE_RATIO_THRESHOLD)).toBe(false);
  });

  it("breaches on a ratio well past the line", () => {
    expect(breachesMaeThreshold("4.5000", DEFAULT_MAE_RATIO_THRESHOLD)).toBe(true);
  });

  it("honours a threshold the caller tightened", () => {
    expect(breachesMaeThreshold("0.6000", 0.5)).toBe(true);
    expect(breachesMaeThreshold("0.6000", 2)).toBe(false);
  });

  it("does not treat an unmeasurable ratio as a breach", () => {
    // A SKU that sold nothing is not a badly forecast SKU, and filling the
    // watchlist with items nobody can act on is how a monitor gets switched off.
    expect(breachesMaeThreshold(null, DEFAULT_MAE_RATIO_THRESHOLD)).toBe(false);
    expect(breachesMaeThreshold("not a number", DEFAULT_MAE_RATIO_THRESHOLD)).toBe(false);
  });
});

describe("C7 staleness policy", () => {
  const generated = new Date("2026-01-01T00:00:00.000Z");

  it("is fresh inside the horizon it claims to speak for", () => {
    expect(isStaleVersion(generated, 4, new Date("2026-01-20T00:00:00.000Z"))).toBe(false);
  });

  it("is stale once it has outlived that horizon", () => {
    expect(isStaleVersion(generated, 4, new Date("2026-02-01T00:00:00.000Z"))).toBe(true);
  });

  it("ages a long-horizon forecast more slowly than a short one", () => {
    // One global staleness setting would be wrong for at least one of them.
    const at = new Date("2026-02-01T00:00:00.000Z");
    expect(isStaleVersion(generated, 4, at)).toBe(true);
    expect(isStaleVersion(generated, 26, at)).toBe(false);
  });

  it("reports whole days of age, never a negative one", () => {
    expect(ageInDays(generated, new Date("2026-01-11T12:00:00.000Z"))).toBe(10);
    expect(ageInDays(generated, new Date("2025-12-01T00:00:00.000Z"))).toBe(0);
  });
});

describe("C7 alerting does not change the model", () => {
  /**
   * The guarantee the whole unit rests on: a monitor that regenerates the
   * forecast it is monitoring destroys the evidence it exists to preserve, and
   * the next reader cannot tell whether the number moved because demand moved
   * or because somebody looked at it.
   *
   * Asserted by handing the service a `db` whose writing methods throw. A test
   * that only asserted the return value would pass against an implementation
   * that quietly re-ran the forecast on the way past.
   */
  function readOnlyDb() {
    const forbid = (name: string) => () => {
      throw new Error(`drift monitoring must not call db.${name}`);
    };
    return {
      execute: jest.fn().mockResolvedValue([]),
      insert: forbid("insert"),
      update: forbid("update"),
      delete: forbid("delete"),
      transaction: forbid("transaction"),
    };
  }

  function build(db: ReturnType<typeof readOnlyDb>) {
    const drift = { drift: jest.fn().mockResolvedValue({ status: "stable", findings: [] }) };
    const versions = {
      versions: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 }),
    };
    const baselines = { scopeFor: jest.fn().mockResolvedValue(null) };
    const warehouseScope = {
      forUser: jest.fn().mockResolvedValue({
        key: "all",
        isEmpty: false,
        unrestricted: true,
        warehouse: () => ({}),
        location: () => ({}),
        anyOf: () => ({}),
      }),
    };
    return {
      service: new DriftMonitorService(
        db as never,
        drift as never,
        versions as never,
        baselines as never,
        warehouseScope as never,
      ),
      drift,
      versions,
    };
  }

  it("reads the watchlist without writing anything", async () => {
    const db = readOnlyDb();
    const { service } = build(db);
    const result = await service.watchlist("org-1", "user-1", { page: 1, limit: 20 });
    expect(result.items).toEqual([]);
    expect(db.execute).toHaveBeenCalled();
  });

  it("builds the detail report from stored versions rather than regenerating one", async () => {
    const db = readOnlyDb();
    const { service, drift, versions } = build(db);
    const detail = await service.detail("org-1", "user-1", 10, {});
    expect(drift.drift).toHaveBeenCalledTimes(1);
    expect(versions.versions).toHaveBeenCalledTimes(1);
    expect(detail.evidence.productVariantId).toBe(10);
    expect(detail.evidence.totalVersions).toBe(0);
  });

  it("returns an empty watchlist for an operator with no warehouses", async () => {
    const db = readOnlyDb();
    const drift = { drift: jest.fn() };
    const versions = { versions: jest.fn() };
    const baselines = { scopeFor: jest.fn() };
    const warehouseScope = {
      forUser: jest.fn().mockResolvedValue({
        key: "none",
        isEmpty: true,
        unrestricted: false,
        warehouse: () => ({}),
        location: () => ({}),
        anyOf: () => ({}),
      }),
    };
    const service = new DriftMonitorService(
      db as never,
      drift as never,
      versions as never,
      baselines as never,
      warehouseScope as never,
    );
    const result = await service.watchlist("org-1", "user-1", { page: 1, limit: 20 });
    expect(result.total).toBe(0);
    expect(result.summary.tracked).toBe(0);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
