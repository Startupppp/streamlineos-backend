import { BadRequestException, ConflictException, UnprocessableEntityException } from "@nestjs/common";
import { StockEngineService, addDec, mulDec, divDec } from "../stock-engine.service";
import type { StockEngineCommand } from "../stock-engine.types";

function makeInsertChain(txnReturningId?: number, conflictRows: Array<{ id: number }> = [{ id: 1 }]) {
  const returning = jest.fn().mockResolvedValue(txnReturningId !== undefined ? [{ id: txnReturningId }] : []);
  // ON CONFLICT DO NOTHING ... RETURNING: rows when the row was claimed, [] when
  // it already existed. The engine branches on that instead of catching a thrown
  // duplicate-key error, which in real Postgres aborts the whole transaction.
  const conflictReturning = jest.fn().mockResolvedValue(conflictRows);
  const onConflictDoNothing = jest.fn().mockImplementation(() =>
    Object.assign(Promise.resolve(undefined), { returning: conflictReturning }),
  );
  const values = jest.fn().mockImplementation(() =>
    Object.assign(Promise.resolve(undefined), { onConflictDoNothing, returning }),
  );
  return { values };
}

/** The idempotency key already existed — the claim insert returns zero rows. */
function makeClaimedInsertChain() {
  return makeInsertChain(undefined, []);
}

function makeUpdateChain() {
  const returning = jest.fn().mockResolvedValue([]);
  const where = jest.fn().mockImplementation(() =>
    Object.assign(Promise.resolve(undefined), { returning }),
  );
  const set = jest.fn().mockReturnValue({ where });
  return { set };
}

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(rows),
      }),
      where: jest.fn().mockResolvedValue(rows),
    }),
  };
}

type MockTx = {
  insert: jest.Mock;
  update: jest.Mock;
  execute: jest.Mock;
  select: jest.Mock;
  query: {
    invIdempotencyKeys: { findFirst: jest.Mock };
    invProductVariants: { findFirst: jest.Mock };
    invStockTransactions: { findFirst: jest.Mock };
  };
};

/**
 * The engine locks every grain in one ordered statement and matches the rows
 * back by natural key, so the fixture has to carry the grain columns the real
 * SELECT returns — without them every lookup misses and the engine reports the
 * location as missing.
 */
const LEVEL_GRAIN = { product_variant_id: 1, location_id: 1, lot_id: null, serial_id: null };

function buildTx(levelRow?: Record<string, unknown>): MockTx {
  const level = {
    ...LEVEL_GRAIN,
    ...(levelRow ?? {
      id: 1, on_hand: "0.0000", committed: "0.0000",
      blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null,
    }),
  };
  return {
    insert: jest.fn(),
    update: jest.fn().mockReturnValue(makeUpdateChain()),
    execute: jest.fn().mockResolvedValue([level]),
    select: jest.fn().mockImplementation(() => makeSelectChain()),
    query: {
      invIdempotencyKeys: { findFirst: jest.fn().mockResolvedValue(null) },
      invProductVariants: { findFirst: jest.fn().mockResolvedValue({ product: { costingMethod: "WEIGHTED_AVERAGE" } }) },
      invStockTransactions: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  };
}

function buildDb(tx: MockTx) {
  return {
    transaction: jest.fn().mockImplementation(async (fn: (tx: MockTx) => Promise<unknown>) => fn(tx)),
  };
}

function defaultSettings(overrides?: Partial<{ allowNegativeStock: boolean }>) {
  return {
    get: jest.fn().mockResolvedValue({
      allowNegativeStock: false,
      allowBackorders: false,
      reservationStrategy: "MANUAL",
      defaultCostingMethod: "WEIGHTED_AVERAGE",
      ...overrides,
    }),
  };
}

function defaultAudit() {
  return { insert: jest.fn().mockResolvedValue(undefined) };
}

function defaultMovementCosting() {
  return {
    plan: jest.fn(async () => ({ kind: "receipt", costingMethod: "FIFO", unitCost: null, totalCost: null })),
    commit: jest.fn(async () => null),
    emitLowStock: jest.fn(async () => undefined),
  };
}

/**
 * The engine now talks to PostingPeriodGuard, not PeriodsService directly — the
 * guard skips the check entirely when accounting_periods is absent, which is why
 * every command against this database used to die on 42P01.
 */
function defaultPeriods() {
  return { assertOpen: jest.fn(async () => undefined) };
}

function defaultWarehouseScope() {
  return {
    resolve: jest.fn(async () => null),
    assertLocationsInScope: jest.fn(async () => undefined),
  };
}

function defaultValuation() {
  return {
    recordReceipt: jest.fn(async () => null),
    recordIssue: jest.fn(async () => ({ totalCost: "0.0000", unitCost: "0.0000", uncoveredQuantity: "0.0000" })),
    reverseReceiptLayer: jest.fn(async () => true),
  };
}

function defaultCache() {
  return {
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
}

function setupInserts(tx: MockTx, txnId = 101) {
  let idx = 0;
  const chains = [
    makeInsertChain(),
    makeInsertChain(),
    makeInsertChain(txnId),
    makeInsertChain(),
  ];
  tx.insert = jest.fn().mockImplementation(() => chains[idx++] ?? makeInsertChain());
}

const baseCmd: StockEngineCommand = {
  idempotencyKey: "idem-1",
  sourceType: "manual",
  sourceId: "adj-1",
  movements: [{
    transactionType: "ADJUSTMENT_IN",
    productVariantId: 1,
    locationId: 1,
    quantityDelta: "10.0000",
  }],
};

describe("arithmetic helpers", () => {
  describe("addDec", () => {
    it("adds two decimal strings to 4 decimal places", () => {
      expect(addDec("1.0000", "2.0000")).toBe("3.0000");
      expect(addDec("10.5000", "0.5000")).toBe("11.0000");
    });
    it("handles negative delta", () => {
      expect(addDec("10.0000", "-3.0000")).toBe("7.0000");
    });
    it("preserves 4 decimal places on whole numbers", () => {
      expect(addDec("5", "3")).toBe("8.0000");
    });
    it("produces negative result correctly", () => {
      expect(addDec("3.0000", "-10.0000")).toBe("-7.0000");
    });
  });

  describe("mulDec", () => {
    it("multiplies two decimal strings to 4 places", () => {
      expect(mulDec("5.0000", "2.0000")).toBe("10.0000");
    });
    it("negates with -1 multiplier", () => {
      expect(mulDec("3.5000", "-1")).toBe("-3.5000");
    });
    it("multiplies fractional values", () => {
      expect(mulDec("3.0000", "0.5000")).toBe("1.5000");
    });
  });

  describe("divDec", () => {
    it("divides to 4 decimal places", () => {
      expect(divDec("10.0000", "4.0000")).toBe("2.5000");
    });
    it("returns 0 on division by zero", () => {
      expect(divDec("10.0000", "0")).toBe("0.0000");
    });
    it("handles non-divisible result", () => {
      expect(divDec("1.0000", "3.0000")).toBe("0.3333");
    });
  });
});

describe("StockEngineService", () => {
  describe("execute — happy path balance math", () => {
    it("returns correct onHand when starting from zero and adding 10", async () => {
      const tx = buildTx();
      setupInserts(tx);
      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never, defaultValuation() as never, defaultWarehouseScope() as never, defaultPeriods() as never, defaultMovementCosting() as never);

      const result = await service.execute("org1", "u1", baseCmd);

      expect(result.transactionIds).toContain(101);
      expect(result.levels).toHaveLength(1);
      expect(result.levels[0].onHand).toBe("10.0000");
    });

    it("accumulates on existing balance: before=5, delta=+10 → after=15", async () => {
      const tx = buildTx({ id: 1, on_hand: "5.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null });
      setupInserts(tx, 201);
      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never, defaultValuation() as never, defaultWarehouseScope() as never, defaultPeriods() as never, defaultMovementCosting() as never);

      const result = await service.execute("org1", "u1", { ...baseCmd, idempotencyKey: "idem-2" });

      expect(result.levels[0].onHand).toBe("15.0000");
    });
  });

  describe("execute — repeated grain in one command", () => {
    it("carries the first movement's result into the second rather than reading a stale before-quantity", async () => {
      const tx = buildTx({ id: 1, on_hand: "5.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null });
      // Locking is a snapshot taken once per command, so a second movement over
      // the same grain has to see the first one's write. Reading the snapshot
      // twice would post before=5 twice and lose one of the deltas.
      // chain 0 claims the idempotency key, chain 1 creates the stock row,
      // chains 2 and 3 are the two ledger movements
      let txnId = 400;
      let call = 0;
      tx.insert = jest.fn().mockImplementation(() =>
        call++ < 2 ? makeInsertChain() : makeInsertChain(++txnId),
      );
      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never, defaultValuation() as never, defaultWarehouseScope() as never, defaultPeriods() as never, defaultMovementCosting() as never);

      const cmd: StockEngineCommand = {
        ...baseCmd,
        idempotencyKey: "same-grain",
        movements: [
          { transactionType: "ADJUSTMENT_IN", productVariantId: 1, locationId: 1, quantityDelta: "10.0000" },
          { transactionType: "ADJUSTMENT_IN", productVariantId: 1, locationId: 1, quantityDelta: "3.0000" },
        ],
      };

      const result = await service.execute("org1", "u1", cmd);

      expect(result.levels.map((l) => l.onHand)).toEqual(["15.0000", "18.0000"]);
    });

    it("locks the grain once however many movements reference it", async () => {
      const tx = buildTx();
      let ledgerId = 500;
      let insertCall = 0;
      tx.insert = jest.fn().mockImplementation(() =>
        insertCall++ < 2 ? makeInsertChain() : makeInsertChain(++ledgerId),
      );
      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never, defaultValuation() as never, defaultWarehouseScope() as never, defaultPeriods() as never, defaultMovementCosting() as never);

      await service.execute("org1", "u1", {
        ...baseCmd,
        idempotencyKey: "one-lock",
        movements: [
          { transactionType: "ADJUSTMENT_IN", productVariantId: 1, locationId: 1, quantityDelta: "1.0000" },
          { transactionType: "ADJUSTMENT_IN", productVariantId: 1, locationId: 1, quantityDelta: "1.0000" },
        ],
      });

      const lockingCalls = tx.execute.mock.calls.filter((call) =>
        JSON.stringify(call[0]).includes("FOR UPDATE"),
      );
      expect(lockingCalls).toHaveLength(1);
    });
  });

  describe("execute — negative stock policy", () => {
    it("throws BadRequestException when allowNegativeStock=false and result is negative", async () => {
      const tx = buildTx({ id: 1, on_hand: "3.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null });
      setupInserts(tx);
      const settings = defaultSettings({ allowNegativeStock: false });
      const service = new StockEngineService(buildDb(tx) as never, settings as never, defaultAudit() as never, defaultCache() as never, defaultValuation() as never, defaultWarehouseScope() as never, defaultPeriods() as never, defaultMovementCosting() as never);

      const cmd: StockEngineCommand = { ...baseCmd, idempotencyKey: "neg-1", movements: [{ ...baseCmd.movements[0], transactionType: "SALE", quantityDelta: "-10.0000" }] };

      await expect(service.execute("org1", "u1", cmd)).rejects.toThrow(BadRequestException);
    });

    it("succeeds when allowNegativeStock=true even if result is negative", async () => {
      const tx = buildTx({ id: 1, on_hand: "3.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null });
      tx.execute = jest.fn()
        .mockResolvedValue([{ ...LEVEL_GRAIN, id: 1, on_hand: "3.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null }]);
      setupInserts(tx, 301);
      const settings = defaultSettings({ allowNegativeStock: true });
      const service = new StockEngineService(buildDb(tx) as never, settings as never, defaultAudit() as never, defaultCache() as never, defaultValuation() as never, defaultWarehouseScope() as never, defaultPeriods() as never, defaultMovementCosting() as never);

      const cmd: StockEngineCommand = { ...baseCmd, idempotencyKey: "neg-ok", movements: [{ ...baseCmd.movements[0], transactionType: "SALE", quantityDelta: "-10.0000" }] };

      const result = await service.execute("org1", "u1", cmd);
      expect(result.levels[0].onHand).toBe("-7.0000");
    });
  });

  describe("execute — idempotency", () => {
    it("throws ConflictException when key is IN_FLIGHT and lease is still active", async () => {
      const tx = buildTx();
      let idx = 0;
      tx.insert = jest.fn().mockImplementation(() => idx++ === 0 ? makeClaimedInsertChain() : makeInsertChain());
      tx.query.invIdempotencyKeys.findFirst = jest.fn().mockResolvedValue({
        status: "IN_FLIGHT",
        requestHash: null,
        response: null,
        createdAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 86_400_000),
      });

      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never, defaultValuation() as never, defaultWarehouseScope() as never, defaultPeriods() as never, defaultMovementCosting() as never);

      await expect(service.execute("org1", "u1", baseCmd)).rejects.toThrow(ConflictException);
    });

    it("replays stored response when idempotency key is COMPLETED (no exception)", async () => {
      const storedResult = { transactionIds: [999], levels: [{ productVariantId: 1, locationId: 1, onHand: "10.0000" }] };
      const tx = buildTx();
      let idx = 0;
      tx.insert = jest.fn().mockImplementation(() => idx++ === 0 ? makeClaimedInsertChain() : makeInsertChain());
      tx.query.invIdempotencyKeys.findFirst = jest.fn().mockResolvedValue({
        status: "COMPLETED",
        requestHash: null,
        response: storedResult,
        createdAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 86_400_000),
      });

      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never, defaultValuation() as never, defaultWarehouseScope() as never, defaultPeriods() as never, defaultMovementCosting() as never);

      const result = await service.execute("org1", "u1", baseCmd);

      expect(result.transactionIds).toEqual([999]);
      expect(result.levels).toHaveLength(1);
      expect(result.levels[0].onHand).toBe("10.0000");
    });

    it("throws UnprocessableEntityException when idempotency key was used with a different request", async () => {
      const tx = buildTx();
      let idx = 0;
      tx.insert = jest.fn().mockImplementation(() => idx++ === 0 ? makeClaimedInsertChain() : makeInsertChain());
      tx.query.invIdempotencyKeys.findFirst = jest.fn().mockResolvedValue({
        status: "COMPLETED",
        requestHash: "a-completely-different-stored-hash",
        response: { transactionIds: [42], levels: [] },
        createdAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 86_400_000),
      });

      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never, defaultValuation() as never, defaultWarehouseScope() as never, defaultPeriods() as never, defaultMovementCosting() as never);

      await expect(service.execute("org1", "u1", baseCmd)).rejects.toThrow(UnprocessableEntityException);
    });
  });

  // Weighted-average recomputation and FIFO layer consumption moved to
  // ValuationService — covered directly in valuation.service.spec.ts against the
  // real implementation rather than through the engine's mocks.
});
