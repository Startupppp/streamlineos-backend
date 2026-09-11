import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InvStockAdjustmentsService } from "../inv-stock-adjustments.service";

const mockWarehouseScope = {
  forUser: jest.fn().mockResolvedValue({
    key: "all",
    isEmpty: false,
    unrestricted: true,
    warehouse: () => ({ queryChunks: [] }),
    location: () => ({ queryChunks: [] }),
    anyOf: () => ({ queryChunks: [] }),
  }),
  scopeKey: jest.fn().mockReturnValue("all"),
  resolve: jest.fn(async () => null),
  warehouseIdList: jest.fn(() => null),
  assertLocationsInScope: jest.fn(async () => undefined),
};

// D8. The write-off value is a cost field, so the service asks whether the
// caller may see one before it answers. These cases are about routing, so the
// answer is yes and the shape of the payload never changes under them.
const mockCostVisibility = { canSeeCost: jest.fn(async () => true) };


/**
 * A3. `createAdjustment` now claims its idempotency key on the transaction it
 * is given, so the transaction handed to the callback has to answer the claim
 * as well as the insert: `values().onConflictDoNothing().returning()` for the
 * key row, and `query.invStockAdjustments.findFirst` for the re-read the
 * immediate-post branch does inside the claim.
 */
export function makeTx(findFirst: jest.Mock) {
  const values = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([{ id: 1, refNum: "ADJ-00001" }]),
    onConflictDoNothing: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 1 }]),
    }),
  });
  return {
    insert: jest.fn().mockReturnValue({ values }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) }),
    select: jest.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      for (const link of ["from", "where", "limit"]) {
        chain[link] = jest.fn(() => chain);
      }
      chain["then"] = async (
        resolve: (rows: unknown[]) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(findFirst()).then((row) => resolve(row ? [row] : []), reject);
      return chain;
    }),
    // D8. The posting reads its own cost back off the ledger rows the engine
    // just wrote, so the transaction has to answer that too.
    execute: jest.fn().mockResolvedValue([{ value: "42.0000" }]),
    query: { invStockAdjustments: { findFirst } },
  };
}

function makeDb(adjRow?: Partial<{ id: number; status: string; referenceNumber: string; reason: string; notes: string | null; lines: unknown[] }>) {
  const returning = jest.fn().mockResolvedValue([{ id: 1, referenceNumber: "ADJ-00001" }]);
  const insert = jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning }) });
  const updateChain = { set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) };
  const update = jest.fn().mockReturnValue(updateChain);
  const defaultAdj = { id: 1, status: "PENDING_APPROVAL", referenceNumber: "ADJ-00001", reason: "DAMAGE", notes: null, lines: [] };
  const findFirst = jest.fn().mockResolvedValue(adjRow ? { ...defaultAdj, ...adjRow } : defaultAdj);
  const transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(makeTx(findFirst)));
  // A4. `createAdjustment` now runs the correction gate before anything else, so
  // the mock has to answer it: it loads the named variants and refuses any whose
  // product has been deleted. Returning a live row keeps these cases about
  // threshold routing, which is what they are for.
  //
  // D8 added two more reads on the same builder — the value threshold on
  // `inv_settings`, and the scrap bin for a write-off reason — so the chain is
  // generic rather than one fixed shape. Only the joined query (the variant
  // gate) answers with rows; the others answer empty, which is what "this org
  // has no value threshold and no scrap bin" looks like.
  //
  // Before either, `createAdjustment` resolves every line's variant and location
  // against the organisation, so a line naming something that is not there is a
  // 404 rather than a raw foreign-key 500. Those two reads are the only bare
  // `{ id }` selects with no join, order or limit, and they answer with ids 1
  // and 2 — the ids these cases use. (The scrap-bin fallback also selects
  // `{ id }`, but ordered and limited, so it still answers empty.)
  const variantRows = [1, 2].map((id) => ({
    id,
    productId: id,
    sku: `SKU-${String(id)}`,
    costPrice: "1.0000",
    sellingPrice: "2.0000",
    variantActive: true,
    productStatus: "ACTIVE",
    productDeletedAt: null,
  }));
  const idRows = [{ id: 1 }, { id: 2 }];
  const select = jest.fn().mockImplementation((fields?: Record<string, unknown>) => {
    let joined = false;
    let bounded = false;
    const chain: Record<string, unknown> = {};
    const step = jest.fn(() => chain);
    chain.from = step;
    chain.where = step;
    chain.orderBy = jest.fn(() => { bounded = true; return chain; });
    chain.limit = jest.fn(() => { bounded = true; return chain; });
    chain.innerJoin = jest.fn(() => { joined = true; return chain; });
    chain.then = (resolve: (rows: unknown[]) => unknown) => {
      if (joined) return resolve(variantRows);
      const idLookup = !bounded && fields !== undefined && Object.keys(fields).length === 1 && "id" in fields;
      return resolve(idLookup ? idRows : []);
    };
    return chain;
  });

  return {
    insert, update, transaction, select,
    execute: jest.fn().mockResolvedValue([]),
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
    mockCostVisibility as never,
    glBridge as never,
  );
  return { svc, db, engine, settings };
}

const baseLines = [
  { productVariantId: 1, locationId: 1, quantityChange: 10 },
  { productVariantId: 2, locationId: 1, quantityChange: -5 },
];

// D8. Mixed directions are legitimate on a correction and never on a write-off,
// so the routing cases above carry a neutral reason and the write-off rule is
// asserted on its own below.
const writeOffLines = [
  { productVariantId: 1, locationId: 1, quantityChange: -10 },
  { productVariantId: 2, locationId: 1, quantityChange: -5 },
];

describe("InvStockAdjustmentsService — threshold routing", () => {
  describe("no threshold configured (null)", () => {
    it("auto-posts when threshold is null", async () => {
      const { svc, engine } = buildService(null);
      await svc.createAdjustment("org1", "u1", { reason: "OTHER", lines: baseLines }, "idem-1");
      expect(engine.executeInTx).toHaveBeenCalledTimes(1);
    });

    it("posts the movement to the ledger on the posting transaction (ACC-21)", async () => {
      const { svc, engine } = buildService(null);
      await svc.createAdjustment("org1", "u1", { reason: "OTHER", lines: baseLines }, "idem-gl-1");
      const postingTx = engine.executeInTx.mock.calls[0][0];
      expect(glBridge.post).toHaveBeenCalledWith(
        "org1",
        "u1",
        expect.objectContaining({ kind: "adjustment", documentId: "1", transactionIds: [1] }),
        postingTx,
      );
    });

    it("refuses a line naming a location this organisation does not have", async () => {
      const { svc, engine } = buildService(null);
      await expect(
        svc.createAdjustment(
          "org1",
          "u1",
          { reason: "OTHER", lines: [{ productVariantId: 1, locationId: 99, quantityChange: 1 }] },
          "idem-foreign-1",
        ),
      ).rejects.toThrow(NotFoundException);
      expect(engine.executeInTx).not.toHaveBeenCalled();
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
      await svc.createAdjustment("org1", "u1", { reason: "OTHER", lines: baseLines }, "idem-4");
      expect(engine.executeInTx).not.toHaveBeenCalled();
    });

    it("creates adjustment with PENDING_APPROVAL status when above threshold", async () => {
      const { svc, db } = buildService("5");
      await svc.createAdjustment("org1", "u1", { reason: "OTHER", lines: baseLines }, "idem-5");
      const txFn = (db.transaction as jest.Mock).mock.calls[0][0] as (tx: unknown) => Promise<unknown>;
      const tx = makeTx(db.query.invStockAdjustments.findFirst);
      await txFn(tx);
      const insertCall = tx.insert.mock.calls[0];
      expect(insertCall).toBeDefined();
    });
  });

  describe("approve + post flow", () => {
    it("throws when trying to approve a POSTED adjustment", async () => {
      const { svc } = buildService("5", { id: 1, status: "POSTED" });
      await expect(svc.approveAdjustment("org1", "u1", 1, "approve-posted-key")).rejects.toThrow(BadRequestException);
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
        mockCostVisibility as never,
        glBridge as never,
      );
      await expect(svc.getAdjustment("org1", 999, "user-1")).rejects.toThrow(NotFoundException);
    });
  });

  describe("D8 — a write-off may only remove stock", () => {
    it("refuses a write-off reason on a line that adds stock", async () => {
      const { svc, engine } = buildService(null);
      await expect(
        svc.createAdjustment("org1", "u1", { reason: "THEFT", lines: baseLines }, "idem-wo-1"),
      ).rejects.toThrow(BadRequestException);
      // Nothing reached the ledger: the refusal is before the transaction opens.
      expect(engine.executeInTx).not.toHaveBeenCalled();
    });

    it("accepts a write-off whose every line removes stock", async () => {
      const { svc, engine } = buildService(null);
      await svc.createAdjustment("org1", "u1", { reason: "SCRAP", lines: writeOffLines }, "idem-wo-2");
      expect(engine.executeInTx).toHaveBeenCalledTimes(1);
    });

    it("refuses a scrap location on a reason that is not a write-off", async () => {
      const { svc } = buildService(null);
      await expect(
        svc.createAdjustment(
          "org1",
          "u1",
          { reason: "RECOUNT", lines: baseLines, scrapLocationId: 7 },
          "idem-wo-3",
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("cancel", () => {
    it("throws when trying to cancel a POSTED adjustment", async () => {
      const { svc } = buildService("5", { id: 1, status: "POSTED" });
      await expect(svc.cancelAdjustment("org1", "user-1", 1)).rejects.toThrow(BadRequestException);
    });

    it("cancels a PENDING_APPROVAL adjustment without error", async () => {
      const { svc, db } = buildService("5");
      db.query.invStockAdjustments.findFirst = jest.fn().mockResolvedValue({ id: 1, status: "PENDING_APPROVAL" });
      await expect(svc.cancelAdjustment("org1", "user-1", 1)).resolves.not.toThrow();
    });
  });
});
