import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { AGE_BAND_LABELS, WorkAgingService } from "./work-aging.service";

/**
 * The defect this endpoint exists to avoid.
 *
 * On the throughput report, an operator assigned no warehouse and a warehouse
 * with nothing in it produce byte-identical responses. A dashboard reading that
 * can only say "the warehouse is idle" — which, for the operator who has been
 * assigned nothing, is wrong, unactionable, and points them away from the only
 * thing that would fix it. So the aging report answers the scope question
 * explicitly, and `[]` is a value with a meaning rather than an absence.
 *
 * These are unit tests against fakes on purpose. The empty-scope answer must not
 * depend on a query returning nothing — that is the coincidence that made the
 * two states indistinguishable in the first place — so the test asserts the
 * database is never reached.
 */
describe("WorkAgingService", () => {
  const execute = jest.fn();
  const resolve = jest.fn();
  const assertWarehouseVisible = jest.fn();
  const warehousePredicate = jest.fn(() => sql`TRUE`);
  const locationPredicate = jest.fn(() => sql`TRUE`);

  const service = new WorkAgingService(
    { execute } as unknown as Db,
    {
      resolve,
      assertWarehouseVisible,
      warehousePredicate,
      locationPredicate,
    } as unknown as WarehouseScopeService,
  );

  const STAGES = ["receipts", "putaway", "picking", "pickExceptions", "shipping"] as const;

  beforeEach(() => {
    jest.clearAllMocks();
    execute.mockResolvedValue([]);
    resolve.mockResolvedValue(null);
    assertWarehouseVisible.mockResolvedValue(undefined);
  });

  it("says the caller is assigned no warehouse rather than that the warehouse is idle", async () => {
    resolve.mockResolvedValue([]);

    const result = await service.workAging("org_1", "user_1", { asOf: "2026-08-29" });

    // The load-bearing assertion: `[]`, never `null` and never absent. `null`
    // would claim the caller sees the whole organisation, and an omitted field
    // reads as the idle warehouse this report exists to distinguish.
    expect(result.scopedWarehouseIds).toEqual([]);
    expect(result.scopedWarehouseIds).not.toBeNull();
    expect("scopedWarehouseIds" in result).toBe(true);

    for (const stage of STAGES) {
      expect(result[stage].open).toBe(0);
      expect(result[stage].bands.map((b) => b.count)).toEqual([0, 0, 0, 0]);
      expect(result[stage].bands.map((b) => b.oldestHours)).toEqual([null, null, null, null]);
    }

    // Answered from the scope, not from an empty result set.
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports null, not [], for a caller holding the org-wide scope", async () => {
    resolve.mockResolvedValue(null);

    const result = await service.workAging("org_1", "user_1", {});

    expect(result.scopedWarehouseIds).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("names the caller's warehouses when they hold some", async () => {
    resolve.mockResolvedValue([7, 9]);

    const result = await service.workAging("org_1", "user_1", {});

    expect(result.scopedWarehouseIds).toEqual([7, 9]);
  });

  it("returns all four bands for every stage even where nothing is open", async () => {
    execute.mockResolvedValue([
      { stage: "picking", band: "72h+", count: 2, oldest_hours: "101.25" },
    ]);

    const result = await service.workAging("org_1", "user_1", {});

    for (const stage of STAGES) {
      expect(result[stage].bands.map((b) => b.label)).toEqual([...AGE_BAND_LABELS]);
    }
    expect(result.receipts.open).toBe(0);
  });

  it("keeps `open` equal to the sum of its bands", async () => {
    execute.mockResolvedValue([
      { stage: "putaway", band: "0-4h", count: 3, oldest_hours: "3.50" },
      { stage: "putaway", band: "24-72h", count: 4, oldest_hours: "70.10" },
      { stage: "shipping", band: "4-24h", count: 1, oldest_hours: "12.00" },
    ]);

    const result = await service.workAging("org_1", "user_1", {});

    expect(result.putaway.open).toBe(7);
    expect(result.putaway.bands.map((b) => b.count)).toEqual([3, 0, 4, 0]);
    expect(result.shipping.open).toBe(1);
  });

  it("reads the hours the database already rounded, and nulls the empty bands", async () => {
    execute.mockResolvedValue([
      { stage: "receipts", band: "24-72h", count: 1, oldest_hours: "48.75" },
    ]);

    const result = await service.workAging("org_1", "user_1", {});
    const bands = result.receipts.bands;

    // Rounded in numeric by Postgres; the only thing this layer does is read the
    // decimal string it produced.
    expect(bands[2]!.oldestHours).toBe(48.75);
    expect(bands[0]!.oldestHours).toBeNull();
    expect(bands[3]!.oldestHours).toBeNull();
  });

  it("404s on a warehouse the caller may not see, rather than 403", async () => {
    resolve.mockResolvedValue([7]);
    assertWarehouseVisible.mockRejectedValue(new NotFoundException("Not found"));

    await expect(
      service.workAging("org_1", "user_1", { warehouseId: 11 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(execute).not.toHaveBeenCalled();
  });

  it("gates the warehouse filter even for a caller assigned nothing", async () => {
    // An empty scope contains no warehouse, so naming one is a miss — and a miss
    // is a 404. Returning the zero-filled body here would confirm the id exists.
    resolve.mockResolvedValue([]);
    assertWarehouseVisible.mockRejectedValue(new NotFoundException("Not found"));

    await expect(
      service.workAging("org_1", "user_1", { warehouseId: 11 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("defaults `asOf` to today and echoes back the day it measured", async () => {
    const today = new Date().toISOString().slice(0, 10);

    expect((await service.workAging("org_1", "user_1", {})).asOf).toBe(today);
    expect(
      (await service.workAging("org_1", "user_1", { asOf: "2026-01-05" })).asOf,
    ).toBe("2026-01-05");
  });

  it("scopes receiving by location and every other stage by warehouse", async () => {
    resolve.mockResolvedValue([7]);

    await service.workAging("org_1", "user_1", {});

    // inv_grns names a location and no warehouse, so the scope resolves through
    // inv_locations. Four warehouse-attributed stages, one location-attributed.
    expect(locationPredicate).toHaveBeenCalledTimes(1);
    expect(warehousePredicate).toHaveBeenCalledTimes(4);
  });
});
