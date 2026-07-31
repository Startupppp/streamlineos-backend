import { BadRequestException, ConflictException, UnprocessableEntityException } from "@nestjs/common";
import { StockEngineService, addDec, mulDec, divDec } from "../stock-engine.service";
import type { StockEngineCommand } from "../stock-engine.types";

function makeInsertChain(txnReturningId?: number) {
  const returning = jest.fn().mockResolvedValue(txnReturningId !== undefined ? [{ id: txnReturningId }] : []);
  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockImplementation(() =>
    Object.assign(Promise.resolve(undefined), { onConflictDoNothing, returning }),
  );
  return { values };
}

function makeFailInsertChain() {
  return {
    values: jest.fn().mockImplementation(async () => {
      throw new Error("duplicate key value violates unique constraint");
    }),
  };
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

function buildTx(levelRow?: Record<string, unknown>): MockTx {
  const level = levelRow ?? {
    id: 1, on_hand: "0.0000", committed: "0.0000",
    blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null,
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

function defaultCache() {
  return {
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
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
      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never);

      const result = await service.execute("org1", "u1", baseCmd);

      expect(result.transactionIds).toContain(101);
      expect(result.levels).toHaveLength(1);
      expect(result.levels[0].onHand).toBe("10.0000");
    });

    it("accumulates on existing balance: before=5, delta=+10 → after=15", async () => {
      const tx = buildTx({ id: 1, on_hand: "5.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null });
      setupInserts(tx, 201);
      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never);

      const result = await service.execute("org1", "u1", { ...baseCmd, idempotencyKey: "idem-2" });

      expect(result.levels[0].onHand).toBe("15.0000");
    });
  });

  describe("execute — negative stock policy", () => {
    it("throws BadRequestException when allowNegativeStock=false and result is negative", async () => {
      const tx = buildTx({ id: 1, on_hand: "3.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null });
      setupInserts(tx);
      const settings = defaultSettings({ allowNegativeStock: false });
      const service = new StockEngineService(buildDb(tx) as never, settings as never, defaultAudit() as never, defaultCache() as never);

      const cmd: StockEngineCommand = { ...baseCmd, idempotencyKey: "neg-1", movements: [{ ...baseCmd.movements[0], transactionType: "SALE", quantityDelta: "-10.0000" }] };

      await expect(service.execute("org1", "u1", cmd)).rejects.toThrow(BadRequestException);
    });

    it("succeeds when allowNegativeStock=true even if result is negative", async () => {
      const tx = buildTx({ id: 1, on_hand: "3.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null });
      tx.execute = jest.fn()
        .mockResolvedValueOnce([{ id: 1, on_hand: "3.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null }])
        .mockResolvedValueOnce([]);
      setupInserts(tx, 301);
      const settings = defaultSettings({ allowNegativeStock: true });
      const service = new StockEngineService(buildDb(tx) as never, settings as never, defaultAudit() as never, defaultCache() as never);

      const cmd: StockEngineCommand = { ...baseCmd, idempotencyKey: "neg-ok", movements: [{ ...baseCmd.movements[0], transactionType: "SALE", quantityDelta: "-10.0000" }] };

      const result = await service.execute("org1", "u1", cmd);
      expect(result.levels[0].onHand).toBe("-7.0000");
    });
  });

  describe("execute — idempotency", () => {
    it("throws ConflictException when key is IN_FLIGHT and lease is still active", async () => {
      const tx = buildTx();
      let idx = 0;
      tx.insert = jest.fn().mockImplementation(() => idx++ === 0 ? makeFailInsertChain() : makeInsertChain());
      tx.query.invIdempotencyKeys.findFirst = jest.fn().mockResolvedValue({
        status: "IN_FLIGHT",
        requestHash: null,
        response: null,
        createdAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 86_400_000),
      });

      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never);

      await expect(service.execute("org1", "u1", baseCmd)).rejects.toThrow(ConflictException);
    });

    it("replays stored response when idempotency key is COMPLETED (no exception)", async () => {
      const storedResult = { transactionIds: [999], levels: [{ productVariantId: 1, locationId: 1, onHand: "10.0000" }] };
      const tx = buildTx();
      let idx = 0;
      tx.insert = jest.fn().mockImplementation(() => idx++ === 0 ? makeFailInsertChain() : makeInsertChain());
      tx.query.invIdempotencyKeys.findFirst = jest.fn().mockResolvedValue({
        status: "COMPLETED",
        requestHash: null,
        response: storedResult,
        createdAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 86_400_000),
      });

      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never);

      const result = await service.execute("org1", "u1", baseCmd);

      expect(result.transactionIds).toEqual([999]);
      expect(result.levels).toHaveLength(1);
      expect(result.levels[0].onHand).toBe("10.0000");
    });

    it("throws UnprocessableEntityException when idempotency key was used with a different request", async () => {
      const tx = buildTx();
      let idx = 0;
      tx.insert = jest.fn().mockImplementation(() => idx++ === 0 ? makeFailInsertChain() : makeInsertChain());
      tx.query.invIdempotencyKeys.findFirst = jest.fn().mockResolvedValue({
        status: "COMPLETED",
        requestHash: "a-completely-different-stored-hash",
        response: { transactionIds: [42], levels: [] },
        createdAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 86_400_000),
      });

      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never);

      await expect(service.execute("org1", "u1", baseCmd)).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe("execute — weighted average recalc", () => {
    it("recalculates average cost when unitCost provided on positive movement", async () => {
      const tx = buildTx({ id: 1, on_hand: "10.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: "5.0000" });
      setupInserts(tx, 401);
      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never);

      const cmd: StockEngineCommand = { ...baseCmd, idempotencyKey: "wa-1", movements: [{ ...baseCmd.movements[0], quantityDelta: "10.0000", unitCost: "15.0000" }] };

      const result = await service.execute("org1", "u1", cmd);
      expect(result.levels[0].onHand).toBe("20.0000");

      const [updateCall] = tx.update.mock.calls as unknown[][];
      expect(updateCall).toBeDefined();
      const setArg = (tx.update.mock.results[0].value as { set: jest.Mock }).set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.averageCost).toBe("10.0000");
    });
  });

  describe("execute — FIFO layer consumption", () => {
    it("issues two SQL execute calls: one for level lock, one for FIFO layers on negative delta", async () => {
      const tx = buildTx();
      tx.execute = jest.fn()
        .mockResolvedValueOnce([{ id: 1, on_hand: "20.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: "10.0000" }])
        .mockResolvedValueOnce([{ id: 10, remaining_quantity: "20.0000", unit_cost: "10.0000" }]);
      setupInserts(tx, 501);
      const settings = defaultSettings({ allowNegativeStock: true });
      const service = new StockEngineService(buildDb(tx) as never, settings as never, defaultAudit() as never, defaultCache() as never);

      const cmd: StockEngineCommand = { ...baseCmd, idempotencyKey: "fifo-1", movements: [{ ...baseCmd.movements[0], transactionType: "SALE", quantityDelta: "-5.0000" }] };

      const result = await service.execute("org1", "u1", cmd);
      expect(result.levels[0].onHand).toBe("15.0000");
      expect(tx.execute).toHaveBeenCalledTimes(2);
    });

    it("consumes layers in FIFO order (older layers consumed first)", async () => {
      const tx = buildTx();
      tx.execute = jest.fn()
        .mockResolvedValueOnce([{ id: 1, on_hand: "15.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: "8.0000" }])
        .mockResolvedValueOnce([
          { id: 10, remaining_quantity: "5.0000", unit_cost: "6.0000" },
          { id: 11, remaining_quantity: "10.0000", unit_cost: "9.0000" },
        ]);
      setupInserts(tx, 601);
      const settings = defaultSettings({ allowNegativeStock: true });
      const service = new StockEngineService(buildDb(tx) as never, settings as never, defaultAudit() as never, defaultCache() as never);

      const cmd: StockEngineCommand = { ...baseCmd, idempotencyKey: "fifo-order", movements: [{ ...baseCmd.movements[0], transactionType: "SALE", quantityDelta: "-8.0000" }] };

      await service.execute("org1", "u1", cmd);

      const updateCalls = tx.update.mock.calls as unknown[][];
      expect(updateCalls.length).toBeGreaterThanOrEqual(3);
    });
  });
});

describe("StockEngineService.executeMany", () => {
  function buildBatchTx(lockedRows: Record<string, unknown>[]): MockTx {
    return {
      insert: jest.fn(),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
      execute: jest.fn().mockResolvedValueOnce(lockedRows).mockResolvedValue([]),
      select: jest.fn().mockImplementation(() => makeSelectChain()),
      query: {
        invIdempotencyKeys: { findFirst: jest.fn().mockResolvedValue(null) },
        invProductVariants: { findFirst: jest.fn().mockResolvedValue({ product: { costingMethod: "WEIGHTED_AVERAGE" } }) },
        invStockTransactions: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    };
  }

  function setupBatchInserts(tx: MockTx, startId = 100): void {
    let id = startId;
    tx.insert = jest.fn().mockImplementation(() => makeInsertChain(id++));
  }

  describe("lock ordering", () => {
    it("acquires all level locks in a single execute call regardless of command count", async () => {
      const lockedRows = [
        { id: 2, product_variant_id: 1, location_id: 1, lot_id: null, serial_id: null, on_hand: "0.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null },
        { id: 5, product_variant_id: 2, location_id: 2, lot_id: null, serial_id: null, on_hand: "0.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null },
      ];
      const tx = buildBatchTx(lockedRows);
      setupBatchInserts(tx, 200);
      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never);

      const cmd1: StockEngineCommand = { idempotencyKey: "lock-1", sourceType: "t", sourceId: "s", movements: [{ transactionType: "ADJUSTMENT_IN", productVariantId: 1, locationId: 1, quantityDelta: "5.0000" }] };
      const cmd2: StockEngineCommand = { idempotencyKey: "lock-2", sourceType: "t", sourceId: "s", movements: [{ transactionType: "ADJUSTMENT_IN", productVariantId: 2, locationId: 2, quantityDelta: "3.0000" }] };

      await service.executeMany("org1", "u1", [cmd1, cmd2]);

      expect(tx.execute).toHaveBeenCalledTimes(1);
    });

    it("returns empty array for empty command list without touching the db", async () => {
      const tx = buildBatchTx([]);
      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never);

      const result = await service.executeMany("org1", "u1", []);

      expect(result).toEqual([]);
      expect(tx.execute).not.toHaveBeenCalled();
    });
  });

  describe("partial replay", () => {
    it("returns stored result for a replayed command and executes the new command", async () => {
      const storedResult = { transactionIds: [999], levels: [{ productVariantId: 1, locationId: 1, onHand: "10.0000" }] };
      const lockedRows = [
        { id: 3, product_variant_id: 2, location_id: 2, lot_id: null, serial_id: null, on_hand: "0.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null },
      ];
      const tx = buildBatchTx(lockedRows);

      let insertCallCount = 0;
      tx.insert = jest.fn().mockImplementation(() => {
        const callIndex = insertCallCount++;
        if (callIndex === 0) return makeFailInsertChain();
        return makeInsertChain(300 + callIndex);
      });

      tx.query.invIdempotencyKeys.findFirst = jest.fn()
        .mockResolvedValueOnce({
          status: "COMPLETED",
          requestHash: null,
          response: storedResult,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .mockResolvedValue(null);

      const service = new StockEngineService(buildDb(tx) as never, defaultSettings() as never, defaultAudit() as never, defaultCache() as never);

      const replayCmd: StockEngineCommand = { idempotencyKey: "replay-key", sourceType: "t", sourceId: "s", movements: [{ transactionType: "ADJUSTMENT_IN", productVariantId: 1, locationId: 1, quantityDelta: "10.0000" }] };
      const newCmd: StockEngineCommand = { idempotencyKey: "new-key", sourceType: "t", sourceId: "s", movements: [{ transactionType: "ADJUSTMENT_IN", productVariantId: 2, locationId: 2, quantityDelta: "5.0000" }] };

      const [r1, r2] = await service.executeMany("org1", "u1", [replayCmd, newCmd]);

      expect(r1!.transactionIds).toEqual([999]);
      expect(r1!.levels[0]!.onHand).toBe("10.0000");

      expect(r2!.levels[0]!.productVariantId).toBe(2);
      expect(r2!.levels[0]!.onHand).toBe("5.0000");
    });
  });

  describe("FIFO correctness across commands sharing a stock level", () => {
    it("second command reads the in-memory state written by the first command in the same batch", async () => {
      const lockedRows = [
        { id: 1, product_variant_id: 1, location_id: 1, lot_id: null, serial_id: null, on_hand: "0.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null },
      ];
      const tx = buildBatchTx(lockedRows);
      setupBatchInserts(tx, 700);
      const settings = defaultSettings({ allowNegativeStock: false });
      const service = new StockEngineService(buildDb(tx) as never, settings as never, defaultAudit() as never, defaultCache() as never);

      const addCmd: StockEngineCommand = {
        idempotencyKey: "fifo-batch-add",
        sourceType: "t",
        sourceId: "s",
        movements: [{ transactionType: "ADJUSTMENT_IN", productVariantId: 1, locationId: 1, quantityDelta: "20.0000" }],
      };
      const subtractCmd: StockEngineCommand = {
        idempotencyKey: "fifo-batch-sub",
        sourceType: "t",
        sourceId: "s",
        movements: [{ transactionType: "SALE", productVariantId: 1, locationId: 1, quantityDelta: "-5.0000" }],
      };

      const [r1, r2] = await service.executeMany("org1", "u1", [addCmd, subtractCmd]);

      expect(r1!.levels[0]!.onHand).toBe("20.0000");
      expect(r2!.levels[0]!.onHand).toBe("15.0000");
    });

    it("refuses to go negative when the second command overdrafts the balance written by the first", async () => {
      const lockedRows = [
        { id: 1, product_variant_id: 1, location_id: 1, lot_id: null, serial_id: null, on_hand: "0.0000", committed: "0.0000", blocked_qty: "0.0000", quality_hold_qty: "0.0000", average_cost: null },
      ];
      const tx = buildBatchTx(lockedRows);
      setupBatchInserts(tx, 800);
      const settings = defaultSettings({ allowNegativeStock: false });
      const service = new StockEngineService(buildDb(tx) as never, settings as never, defaultAudit() as never, defaultCache() as never);

      const addCmd: StockEngineCommand = {
        idempotencyKey: "fifo-guard-add",
        sourceType: "t",
        sourceId: "s",
        movements: [{ transactionType: "ADJUSTMENT_IN", productVariantId: 1, locationId: 1, quantityDelta: "3.0000" }],
      };
      const overdraftCmd: StockEngineCommand = {
        idempotencyKey: "fifo-guard-sub",
        sourceType: "t",
        sourceId: "s",
        movements: [{ transactionType: "SALE", productVariantId: 1, locationId: 1, quantityDelta: "-10.0000" }],
      };

      await expect(service.executeMany("org1", "u1", [addCmd, overdraftCmd])).rejects.toThrow(BadRequestException);
    });
  });
});
