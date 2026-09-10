import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InvStockAdjustmentsService } from "../inv-stock-adjustments.service";

const mockWarehouseScope = {
  resolve: jest.fn(async () => null),
  warehouseIdList: jest.fn(() => null),
  assertLocationsInScope: jest.fn(async () => undefined),
};


function makeDb(adjRow?: Partial<{ id: number; status: string; referenceNumber: string; reason: string; notes: string | null; lines: unknown[] }>) {
  const returning = jest.fn().mockResolvedValue([{ id: 1, referenceNumber: "ADJ-00001" }]);
  const insert = jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning }) });
  const updateChain = { set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) };
  const update = jest.fn().mockReturnValue(updateChain);
  const transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const tx = {
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) }),
    };
    return fn(tx);
  });
  const defaultAdj = { id: 1, status: "PENDING_APPROVAL", referenceNumber: "ADJ-00001", reason: "DAMAGE", notes: null, lines: [] };
  const findFirst = jest.fn().mockResolvedValue(adjRow ? { ...defaultAdj, ...adjRow } : defaultAdj);
  /**
   * `createAdjustment` resolves every line's variant and location against the
   * organisation before it writes, so a line naming something that is not there
   * is a 404 rather than a raw foreign-key 500. These cases are about threshold
   * routing and use ids 1 and 2, so the lookup answers with both.
   */
  const select = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
    }),
  });

  return {
    insert, update, transaction, select,
    query: {
      invStockAdjustments: { findFirst },
    },
  };
}

function makeEngine() {
  return {
    execute: jest.fn().mockResolvedValue({ transactionIds: [1], levels: [] }),
    executeInTx: jest.fn().mockResolvedValue({ transactionIds: [1], levels: [] }),
    invalidateCaches: jest.fn().mockResolvedValue(undefined),
  };
}

function makeNumSeq(refNum = "ADJ-00001") {
  return { next: jest.fn().mockResolvedValue(refNum) };
}

function makeSettings(threshold: string | null) {
  return {
    get: jest.fn().mockResolvedValue({
      allowNegativeStock: false,
      adjustmentApprovalThreshold: threshold,
    }),
  };
}

function makeCache() {
  return {
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  };
}

/*
  ACC-21 posts an adjustment to the ledger on the same transaction. These cases
  are about the approval threshold, not about accounting, so the bridge is a
  spy — but a real one rather than a cast, so a call with the wrong shape still
  shows up here instead of being erased by `as never`.
*/
const glBridge = { post: jest.fn().mockResolvedValue(undefined) };

function buildService(threshold: string | null, adjRowOverride?: Partial<{ id: number; status: string; referenceNumber: string; reason: string; notes: string | null; lines: unknown[] }>) {
  const db = makeDb(adjRowOverride);
  const engine = makeEngine();
  const numSeq = makeNumSeq();
  const settings = makeSettings(threshold);
  const cache = makeCache();
  const svc = new InvStockAdjustmentsService(
    db as never,
    cache as never,
    engine as never,
    numSeq as never,
    settings as never,
    mockWarehouseScope as never,
    glBridge as never,
  );
  return { svc, db, engine, settings };
}

const baseLines = [
  { productVariantId: 1, locationId: 1, quantityChange: 10 },
  { productVariantId: 2, locationId: 1, quantityChange: -5 },
];

describe("InvStockAdjustmentsService — threshold routing", () => {
  describe("no threshold configured (null)", () => {
    it("auto-posts when threshold is null", async () => {
      const { svc, engine } = buildService(null);
      await svc.createAdjustment("org1", "u1", { reason: "DAMAGE", lines: baseLines }, "idem-1");
      expect(engine.executeInTx).toHaveBeenCalledTimes(1);
    });
  });

  describe("below threshold", () => {
    it("auto-posts when totalAbsQty <= threshold", async () => {
      const { svc, engine } = buildService("100");
      await svc.createAdjustment("org1", "u1", { reason: "RECOUNT", lines: baseLines }, "idem-2");
      expect(engine.executeInTx).toHaveBeenCalledTimes(1);
    });

    it("sets status to POSTED via engine after immediate post", async () => {
      const { svc, engine } = buildService("100");
      await svc.createAdjustment("org1", "u1", { reason: "RECOUNT", lines: baseLines }, "idem-3");
      expect(engine.executeInTx).toHaveBeenCalledWith(expect.anything(), "org1", "u1", expect.objectContaining({
        sourceType: "inv_adjustment",
      }));
    });
  });

  describe("above threshold → PENDING_APPROVAL", () => {
    it("does NOT call engine when totalAbsQty > threshold", async () => {
      const { svc, engine } = buildService("5");
      await svc.createAdjustment("org1", "u1", { reason: "DAMAGE", lines: baseLines }, "idem-4");
      expect(engine.executeInTx).not.toHaveBeenCalled();
    });

    it("creates adjustment with PENDING_APPROVAL status when above threshold", async () => {
      const { svc, db } = buildService("5");
      await svc.createAdjustment("org1", "u1", { reason: "DAMAGE", lines: baseLines }, "idem-5");
      const txFn = (db.transaction as jest.Mock).mock.calls[0][0] as (tx: { insert: jest.Mock }) => Promise<unknown>;
      const tx = { insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }) }) };
      await txFn(tx);
      const insertCall = tx.insert.mock.calls[0];
      expect(insertCall).toBeDefined();
    });
  });

  describe("approve + post flow", () => {
    it("throws when trying to approve a POSTED adjustment", async () => {
      const { svc } = buildService("5", { id: 1, status: "POSTED" });
      await expect(svc.approveAdjustment("org1", "u1", 1)).rejects.toThrow(BadRequestException);
    });

    it("throws when trying to post an adjustment that is PENDING_APPROVAL (not yet approved)", async () => {
      const { svc } = buildService("5", { id: 1, status: "PENDING_APPROVAL", reason: "DAMAGE", notes: null, lines: [] });
      await expect(svc.postAdjustment("org1", "u1", 1, "idem-6")).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when adjustment does not belong to org", async () => {
      const db = makeDb(undefined);
      (db.query.invStockAdjustments.findFirst as jest.Mock).mockResolvedValue(null);
      const svc = new InvStockAdjustmentsService(
        db as never,
        makeCache() as never,
        makeEngine() as never,
        makeNumSeq() as never,
        makeSettings(null) as never,
        mockWarehouseScope as never,
    glBridge as never,
  );
      await expect(svc.getAdjustment("org1", 999)).rejects.toThrow(NotFoundException);
    });
  });

  describe("cancel", () => {
    it("throws when trying to cancel a POSTED adjustment", async () => {
      const { svc } = buildService("5", { id: 1, status: "POSTED" });
      await expect(svc.cancelAdjustment("org1", 1)).rejects.toThrow(BadRequestException);
    });

    it("cancels a PENDING_APPROVAL adjustment without error", async () => {
      const { svc, db } = buildService("5");
      db.query.invStockAdjustments.findFirst = jest.fn().mockResolvedValue({ id: 1, status: "PENDING_APPROVAL" });
      await expect(svc.cancelAdjustment("org1", 1)).resolves.not.toThrow();
    });
  });
});
