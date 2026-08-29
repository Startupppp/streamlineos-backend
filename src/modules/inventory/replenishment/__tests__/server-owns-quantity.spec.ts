import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { generatePoSchema } from "../dto/replenishment.schemas";
import { createPoBatchSchema, previewPoBatchSchema } from "../dto/po-batch.schemas";
import { refreshForecastsSchema } from "../dto/forecast-scope.schemas";
import { applyOrderPolicy } from "../forecast/order-policy";
import {
  orderQuantityFor,
  overrideQuantityFor,
  resolveProposalLines,
  type ProposalOverride,
  type ResolvedProposalRow,
} from "../forecast/po-batch-lines";
import { assertMayCreatePurchaseOrder } from "../forecast/purchase-order-authority";
import { PoBatchService } from "../forecast/po-batch.service";
import { InvReplenishmentService } from "../inv-replenishment.service";

/**
 * C2 — the server owns the quantity, proven without a database.
 *
 * The seeded e2e alongside this (`test/inventory/replenishment-po` and
 * `test/inventory/proposal-override`) asserts the same thing against real
 * Postgres, and does not run without one. These do, on every push, which is why
 * the load-bearing claim — a tampered payload quantity cannot reach a purchase
 * order line — is asserted here as well as there.
 */
function proposal(over: Partial<ResolvedProposalRow> = {}): ResolvedProposalRow {
  return {
    proposalId: 1,
    productVariantId: 10,
    warehouseId: 5,
    warehouseName: "Main",
    reorderPoint: "100",
    applicable: true,
    refusalReason: null,
    generatedAt: "2026-08-01T00:00:00.000Z",
    variantSku: "SKU-1",
    productName: "Widget",
    minOrderQty: null,
    orderMultiple: null,
    vendorId: 7,
    vendorName: "Acme",
    currency: "INR",
    available: "20",
    onOrder: "0",
    lastUnitCost: "2",
    duplicatePoNumber: null,
    ...over,
  };
}

const override = (over: Partial<ProposalOverride> = {}): ProposalOverride => ({
  proposalId: 1,
  quantity: "500",
  reason: "Trade show in Pune next month; the ledger has not seen it yet.",
  ...over,
});

describe("C2 a client quantity never reaches the wire", () => {
  it("drops suggestedQty from the parsed generate-po body", () => {
    // Not rejected — a caller sending one is not doing anything wrong — but
    // absent from the value the service receives, so no future edit can read it.
    const parsed = generatePoSchema.parse({
      vendorId: 7,
      suggestions: [{ productVariantId: 10, suggestedQty: 999_999, unitCost: 4 }],
    });
    expect(parsed.suggestions[0]).toEqual({ productVariantId: 10, unitCost: 4 });
    expect("suggestedQty" in parsed.suggestions[0]!).toBe(false);
  });

  it("accepts a body with no quantity at all", () => {
    const parsed = generatePoSchema.parse({
      vendorId: 7,
      suggestions: [{ productVariantId: 10 }],
    });
    expect(parsed.suggestions).toEqual([{ productVariantId: 10, unitCost: undefined }]);
  });

  it("gives the same parsed body for two different claimed quantities", () => {
    // The tampering test, at the boundary: the two payloads are
    // indistinguishable by the time anything downstream sees them.
    const honest = generatePoSchema.parse({
      vendorId: 7,
      suggestions: [{ productVariantId: 10, suggestedQty: 90 }],
    });
    const tampered = generatePoSchema.parse({
      vendorId: 7,
      suggestions: [{ productVariantId: 10, suggestedQty: 999_999 }],
    });
    expect(tampered).toEqual(honest);
  });

  it("has no quantity field on the batch schemas at all", () => {
    // `.strict()`, so an invented one is a 400 rather than a silent no-op.
    expect(() =>
      createPoBatchSchema.parse({ proposalIds: [1], vendorId: 7, suggestedQty: 500 }),
    ).toThrow();
    expect(() =>
      previewPoBatchSchema.parse({ proposalIds: [1], quantity: "500" }),
    ).toThrow();
  });

  it("takes an override as an exact decimal string, never a float", () => {
    const parsed = createPoBatchSchema.parse({
      proposalIds: [1],
      vendorId: 7,
      overrides: [
        { proposalId: 1, quantity: "500.5000", reason: "Trade show next month." },
      ],
    });
    expect(parsed.overrides[0]!.quantity).toBe("500.5000");
    expect(() =>
      createPoBatchSchema.parse({
        proposalIds: [1],
        vendorId: 7,
        overrides: [{ proposalId: 1, quantity: 500, reason: "Trade show next month." }],
      }),
    ).toThrow();
  });

  it("refuses an override with no usable reason", () => {
    // A required-but-unenforced reason collects "n/a", and a reason nobody can
    // read six months later is the same as no reason at all.
    for (const reason of ["", "   ", "n/a", "asked to"]) {
      expect(() =>
        createPoBatchSchema.parse({
          proposalIds: [1],
          vendorId: 7,
          overrides: [{ proposalId: 1, quantity: "500", reason }],
        }),
      ).toThrow();
    }
  });
});

describe("C2 the proposal sweep is bounded", () => {
  it("caps the sweep well below the read page size", () => {
    // These are writes with a demand baseline, a backtest and a lead-time read
    // behind each one, so the ceiling is lower than the 100 that applies to
    // reads (§3). Fifty concurrent backtests against Neon is how one screen
    // refresh becomes an outage.
    expect(refreshForecastsSchema.parse({}).limit).toBe(25);
    expect(refreshForecastsSchema.parse({ limit: 50 }).limit).toBe(50);
    expect(() => refreshForecastsSchema.parse({ limit: 51 })).toThrow();
    expect(() => refreshForecastsSchema.parse({ limit: 0 })).toThrow();
  });

  it("takes no actor id from the client", () => {
    // The organisation and the person come from the token (root §5).
    expect(() => refreshForecastsSchema.parse({ orgId: "org1" })).toThrow();
    expect(() => refreshForecastsSchema.parse({ userId: "user1" })).toThrow();
  });
});

describe("C2 MOQ and pack size are re-applied server-side", () => {
  it("raises a shortfall to the supplier's minimum", () => {
    const rounded = applyOrderPolicy("7", { minOrderQty: "24", orderMultiple: null });
    expect(rounded.ordered).toBe("24.0000");
    expect(rounded.excess).toBe("17.0000");
    expect(rounded.reasons[0]).toMatch(/minimum order quantity/);
  });

  it("rounds up to a whole number of packs, exactly at the boundary", () => {
    // `Math.ceil(24 / 0.1)` is 241 in floating point. The decimal path gives
    // 240, which is the number the supplier ships.
    const rounded = applyOrderPolicy("24", { minOrderQty: null, orderMultiple: "0.1" });
    expect(rounded.ordered).toBe("24.0000");
  });

  it("applies the minimum first and then the pack size to that", () => {
    const rounded = applyOrderPolicy("7", { minOrderQty: "25", orderMultiple: "12" });
    expect(rounded.ordered).toBe("36.0000");
    expect(rounded.reasons).toHaveLength(2);
  });

  it("never raises a zero shortfall to the minimum", () => {
    // The minimum applies to an order somebody decided to place, not to the
    // decision of whether to place one — otherwise every healthy variant is
    // bought up to the supplier's floor.
    const rounded = applyOrderPolicy("0", { minOrderQty: "24", orderMultiple: "12" });
    expect(rounded.ordered).toBe("0.0000");
    expect(rounded.reasons).toEqual([]);
  });

  it("re-derives the batch quantity from the stored reorder point and the live position", () => {
    const rounded = orderQuantityFor(
      proposal({ reorderPoint: "100", available: "20", onOrder: "10", orderMultiple: "12" }),
    );
    // 100 − (20 + 10) = 70, rounded up to 6 × 12.
    expect(rounded.requested).toBe("70.0000");
    expect(rounded.ordered).toBe("72.0000");
  });
});

describe("C2 an override is a labelled act, not a replacement", () => {
  it("puts the person's number through the supplier's policy too", () => {
    // A buyer overrules the quantity, not the case size: 30 against a case of
    // 12 is 36, and the extra 6 is the policy's doing rather than theirs.
    const row = proposal({ orderMultiple: "12" });
    const rounded = overrideQuantityFor(row, override({ quantity: "30" }), "80.0000");
    expect(rounded.requested).toBe("30.0000");
    expect(rounded.ordered).toBe("36.0000");
    expect(rounded.reasons[0]).toMatch(/Overridden by a person from the engine's 80.0000 to 30/);
    expect(rounded.reasons[1]).toMatch(/pack size/);
  });

  it("keeps the engine's own number on the line beside the override", () => {
    const { lines } = resolveProposalLines([proposal()], [override({ quantity: "500" })]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.engineOrdered).toBe("80.0000");
    expect(lines[0]!.ordered).toBe("500.0000");
    expect(lines[0]!.override).toEqual({
      requested: "500",
      reason: "Trade show in Pune next month; the ledger has not seen it yet.",
    });
  });

  it("leaves every untouched line marked as the engine's", () => {
    const { lines } = resolveProposalLines([proposal()]);
    expect(lines[0]!.override).toBeNull();
    expect(lines[0]!.engineOrdered).toBe(lines[0]!.ordered);
  });

  it("lets a stated override buy against a position the engine says is covered", () => {
    // Without this the buyer raises the order by hand and nothing records why.
    const covered = proposal({ available: "500" });
    expect(resolveProposalLines([covered]).lines).toHaveLength(0);
    const { lines } = resolveProposalLines([covered], [override()]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.engineOrdered).toBe("0.0000");
  });

  it("lets a stated override buy against a forecast refusal", () => {
    const refused = proposal({
      applicable: false,
      reorderPoint: null,
      refusalReason: "Demand is too intermittent for a normal model.",
    });
    expect(resolveProposalLines([refused]).lines).toHaveLength(0);
    expect(resolveProposalLines([refused], [override()]).lines).toHaveLength(1);
  });

  it("still refuses what no conviction resolves", () => {
    // No supplier means nowhere to send the order; a second order for a variant
    // already on an unsent draft doubles the delivery. Neither is a judgement
    // call about demand, so an override does not answer them.
    const noVendor = proposal({ vendorId: null, vendorName: null, currency: null });
    expect(resolveProposalLines([noVendor], [override()]).skipped[0]!.reason).toMatch(
      /No supplier/,
    );
    const duplicate = proposal({ duplicatePoNumber: "PO-00042" });
    expect(resolveProposalLines([duplicate], [override()]).skipped[0]!.reason).toMatch(
      /PO-00042/,
    );
  });
});

describe("C2 the purchase-order key is asserted in the service", () => {
  const access = (keys: string[]) => ({
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map(keys.map((k) => [k, "all"]))),
  });

  it("refuses a caller who holds replenishment but not purchase-order create", async () => {
    await expect(
      assertMayCreatePurchaseOrder(
        access(["inventory:replenishment:manage"]) as never,
        "org1",
        "user1",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows a caller who holds it", async () => {
    await expect(
      assertMayCreatePurchaseOrder(
        access(["inventory:purchase-orders:create"]) as never,
        "org1",
        "user1",
      ),
    ).resolves.toBeUndefined();
  });

  it("stops generatePo before it reads a single proposal", async () => {
    const db = { select: jest.fn(), transaction: jest.fn() };
    const proposals = { propose: jest.fn() };
    const service = new InvReplenishmentService(
      db as never,
      { invalidateNamespace: jest.fn() } as never,
      { next: jest.fn() } as never,
      proposals as never,
      access([]) as never,
    );

    await expect(
      service.generatePo("org1", "user1", { vendorId: 7, suggestions: [{ productVariantId: 10, unitCost: undefined }] }, "key-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();
    expect(proposals.propose).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("stops the batch path before it reads a single proposal", async () => {
    const db = { execute: jest.fn(), transaction: jest.fn() };
    const service = new PoBatchService(
      db as never,
      { get: jest.fn() } as never,
      { next: jest.fn() } as never,
      { forUser: jest.fn(), assertWarehouseVisible: jest.fn() } as never,
      access(["inventory:replenishment:read"]) as never,
    );

    await expect(
      service.create("org1", "user1", { proposalIds: [1], vendorId: 7 }, "key-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("C2 an override has to name a proposal in the batch", () => {
  const buildService = (rows: ResolvedProposalRow[]) => {
    const service = new PoBatchService(
      { execute: jest.fn(), transaction: jest.fn() } as never,
      { get: jest.fn().mockResolvedValue({ requirePoApproval: false }) } as never,
      { next: jest.fn() } as never,
      { assertWarehouseVisible: jest.fn().mockResolvedValue(undefined) } as never,
      {
        resolveUserPermissions: jest
          .fn()
          .mockResolvedValue(new Map([["inventory:purchase-orders:create", "all"]])),
      } as never,
    );
    // `resolve` is the one database read in this path; everything above it is
    // the rule being tested.
    Object.defineProperty(service, "resolve", {
      value: jest.fn().mockResolvedValue(rows),
    });
    return service;
  };

  it("refuses an override for a proposal that is not selected", async () => {
    const service = buildService([proposal({ proposalId: 1 })]);
    await expect(
      service.create(
        "org1",
        "user1",
        { proposalIds: [1], vendorId: 7, overrides: [override({ proposalId: 99 })] },
        "key-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses two overrides for the same proposal", async () => {
    const service = buildService([proposal({ proposalId: 1 })]);
    await expect(
      service.create(
        "org1",
        "user1",
        {
          proposalIds: [1],
          vendorId: 7,
          overrides: [override({ quantity: "500" }), override({ quantity: "600" })],
        },
        "key-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
