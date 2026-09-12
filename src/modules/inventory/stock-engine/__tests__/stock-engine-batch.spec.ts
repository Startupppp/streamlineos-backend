import { StockEngineBatchService } from "../stock-engine-batch.service";
import type { StockEngineCommand } from "../stock-engine.types";

function makeInsertChain(conflictRows: Array<{ id: number }> = [{ id: 1 }]) {
  const returning = jest.fn().mockResolvedValue(conflictRows);
  const onConflictDoNothing = jest.fn().mockImplementation(() =>
    Object.assign(Promise.resolve(undefined), { returning }),
  );
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  return { values };
}

function makeSelectChain() {
  const where = jest.fn().mockResolvedValue([
    { variantId: 1, costingMethod: "WEIGHTED_AVERAGE", productStandardCost: null },
  ]);
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin });
  return { from };
}

function defaultCache() {
  return {
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
}

function makeService(overrides?: {
  tx?: Record<string, unknown>;
  apply?: jest.Mock;
  periods?: { assertOpen: jest.Mock };
}) {
  const tx = {
    insert: jest.fn().mockImplementation(() => makeInsertChain()),
    execute: jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 11,
          product_variant_id: 1,
          location_id: 7,
          lot_id: 3,
          serial_id: null,
          handling_unit_id: 10,
          ownership: "VENDOR",
          on_hand: "5.0000",
          committed: "0.0000",
          blocked_qty: "0.0000",
          quality_hold_qty: "0.0000",
          average_cost: null,
        },
        {
          id: 12,
          product_variant_id: 1,
          location_id: 7,
          lot_id: 3,
          serial_id: null,
          handling_unit_id: null,
          ownership: "OWNED",
          on_hand: "8.0000",
          committed: "0.0000",
          blocked_qty: "0.0000",
          quality_hold_qty: "0.0000",
          average_cost: null,
        },
      ]),
    select: jest.fn().mockImplementation(() => makeSelectChain()),
    query: {
      invIdempotencyKeys: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    ...(overrides?.tx ?? {}),
  };
  const db = {
    transaction: jest.fn().mockImplementation(async (fn: (txArg: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const settings = {
    get: jest.fn().mockResolvedValue({
      allowNegativeStock: false,
      defaultCostingMethod: "WEIGHTED_AVERAGE",
    }),
  };
  const warehouseScope = { assertLocationsInScope: jest.fn().mockResolvedValue(undefined) };
  const periods = overrides?.periods ?? { assertOpen: jest.fn().mockResolvedValue(undefined) };
  const apply =
    overrides?.apply ??
    jest.fn(async (_tx, _orgId, _userId, cmd: StockEngineCommand) => ({
      transactionIds: [Number(cmd.sourceId)],
      levels: [],
    }));

  return {
    tx,
    db,
    settings,
    warehouseScope,
    periods,
    apply,
    service: new StockEngineBatchService(
      db as never,
      settings as never,
      defaultCache() as never,
      warehouseScope as never,
      periods as never,
      { apply } as never,
    ),
  };
}

describe("StockEngineBatchService", () => {
  it("locks full stock grain once and delegates each active command to MovementApplyService", async () => {
    const { service, warehouseScope, periods, apply } = makeService();
    const commands: StockEngineCommand[] = [
      {
        idempotencyKey: "batch-1",
        sourceType: "recall",
        sourceId: "101",
        postingDate: "2026-01-31",
        movements: [
          {
            transactionType: "QUARANTINE_IN",
            productVariantId: 1,
            locationId: 7,
            lotId: 3,
            handlingUnitId: 10,
            ownership: "VENDOR",
            quantityDelta: "5.0000",
            qualityBucket: "QUALITY_HOLD",
          },
        ],
      },
      {
        idempotencyKey: "batch-2",
        sourceType: "recall",
        sourceId: "102",
        postingDate: "2026-02-01",
        movements: [
          {
            transactionType: "QUARANTINE_IN",
            productVariantId: 1,
            locationId: 7,
            lotId: 3,
            quantityDelta: "8.0000",
            qualityBucket: "QUALITY_HOLD",
          },
        ],
      },
    ];

    const result = await service.executeMany("org1", "user1", commands);

    expect(result.map((row) => row.transactionIds[0])).toEqual([101, 102]);
    expect(warehouseScope.assertLocationsInScope).toHaveBeenCalledWith(
      expect.anything(),
      "org1",
      "user1",
      [7, 7],
    );
    expect(periods.assertOpen).toHaveBeenCalledWith("org1", "2026-01-31");
    expect(periods.assertOpen).toHaveBeenCalledWith("org1", "2026-02-01");
    expect(apply).toHaveBeenCalledTimes(2);

    const firstCtx = apply.mock.calls[0]![4];
    const secondCtx = apply.mock.calls[1]![4];
    expect(firstCtx.levels).toBe(secondCtx.levels);
    expect(firstCtx.postingDate).toBe("2026-01-31");
    expect(secondCtx.postingDate).toBe("2026-02-01");
    expect([...firstCtx.levels.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handlingUnitId: 10, ownership: "VENDOR", onHand: "5.0000" }),
        expect.objectContaining({ handlingUnitId: null, ownership: "OWNED", onHand: "8.0000" }),
      ]),
    );
  });
});
