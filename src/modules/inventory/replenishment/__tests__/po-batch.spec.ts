import { BadRequestException } from "@nestjs/common";
import { batchProposals } from "../forecast/order-policy";
import {
  assertSingleSupplierSite,
  blockedReason,
  orderQuantityFor,
  resolveProposalLines,
  type ResolvedProposalRow,
} from "../forecast/po-batch-lines";

/**
 * C6 — the batching rules, exercised without a database.
 *
 * Everything asserted here is a decision rather than a query, which is why it
 * lives in a pure module: a grouping rule that can only be checked against a
 * seeded Postgres is a rule nobody checks, and this one decides which supplier
 * receives which goods.
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

describe("C6 quantity re-derivation", () => {
  it("orders the shortfall against the stored reorder point", () => {
    const rounded = orderQuantityFor(proposal({ reorderPoint: "100", available: "20" }));
    expect(rounded.ordered).toBe("80.0000");
  });

  it("counts goods already on order", () => {
    // Ignoring stock in transit is how a warehouse buys the same shortfall
    // three weeks running.
    const rounded = orderQuantityFor(
      proposal({ reorderPoint: "100", available: "20", onOrder: "70" }),
    );
    expect(rounded.ordered).toBe("10.0000");
  });

  it("never proposes a negative order when the position is already ahead", () => {
    const rounded = orderQuantityFor(
      proposal({ reorderPoint: "100", available: "250", onOrder: "0" }),
    );
    expect(rounded.ordered).toBe("0.0000");
  });

  it("puts the shortfall through the supplier's pack size", () => {
    const rounded = orderQuantityFor(
      proposal({ reorderPoint: "100", available: "87", orderMultiple: "12" }),
    );
    expect(rounded.ordered).toBe("24.0000");
    expect(rounded.reasons[0]).toMatch(/pack size/);
  });
});

describe("C6 grouping by supplier, site and currency", () => {
  const line = (over: {
    vendorId: number;
    vendorName: string;
    warehouseId?: number | null;
    currency?: string;
  }) => ({
    productVariantId: 1,
    productName: "Widget",
    requested: "10.0000",
    ordered: "10.0000",
    engineOrdered: "10.0000",
    override: null,
    unitCost: "5",
    lineValue: "50.0000",
    excess: "0.0000",
    reasons: [],
    vendorId: over.vendorId,
    vendorName: over.vendorName,
    warehouseId: over.warehouseId === undefined ? 5 : over.warehouseId,
    warehouseName: "Main",
    currency: over.currency ?? "INR",
  });

  const policy = { requireApproval: false, approvalThreshold: null };

  it("puts two SKUs from one supplier at one site on one order", () => {
    const batches = batchProposals(
      [line({ vendorId: 7, vendorName: "Acme" }), line({ vendorId: 7, vendorName: "Acme" })],
      policy,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]!.lines).toHaveLength(2);
    expect(batches[0]!.totalValue).toBe("100.0000");
  });

  it("splits two sites, because the warehouse is on the order header", () => {
    // Merging them sends every unit to whichever site sorted first.
    const batches = batchProposals(
      [
        line({ vendorId: 7, vendorName: "Acme", warehouseId: 5 }),
        line({ vendorId: 7, vendorName: "Acme", warehouseId: 6 }),
      ],
      policy,
    );
    expect(batches).toHaveLength(2);
  });

  it("splits two currencies, because an order is priced in exactly one", () => {
    const batches = batchProposals(
      [
        line({ vendorId: 7, vendorName: "Acme", currency: "INR" }),
        line({ vendorId: 7, vendorName: "Acme", currency: "USD" }),
      ],
      policy,
    );
    expect(batches).toHaveLength(2);
  });

  it("keeps an organisation-wide proposal apart from a site one", () => {
    const batches = batchProposals(
      [
        line({ vendorId: 7, vendorName: "Acme", warehouseId: null }),
        line({ vendorId: 7, vendorName: "Acme", warehouseId: 5 }),
      ],
      policy,
    );
    expect(batches).toHaveLength(2);
  });
});

describe("C6 duplicate detection", () => {
  it("refuses a proposal already sitting on an open draft order", () => {
    const row = proposal({ duplicatePoNumber: "PO-00042" });
    const reason = blockedReason(row, orderQuantityFor(row).ordered);
    expect(reason).toMatch(/PO-00042/);
  });

  it("keeps the duplicate out of the lines and says why", () => {
    const { lines, skipped } = resolveProposalLines([
      proposal({ proposalId: 1 }),
      proposal({ proposalId: 2, productVariantId: 11, duplicatePoNumber: "PO-00042" }),
    ]);
    expect(lines).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.proposalId).toBe(2);
    expect(skipped[0]!.reason).toMatch(/PO-00042/);
  });

  it("does not treat a covered position as a duplicate", () => {
    // Two different reasons for producing no line, and conflating them would
    // tell a buyer to go and cancel an order that does not exist.
    const row = proposal({ available: "500" });
    expect(blockedReason(row, orderQuantityFor(row).ordered)).toMatch(
      /already covers the reorder point/,
    );
  });

  it("skips a refusal rather than ordering against a null reorder point", () => {
    const { lines, skipped } = resolveProposalLines([
      proposal({
        applicable: false,
        reorderPoint: null,
        refusalReason: "Demand is too intermittent for a normal model.",
      }),
    ]);
    expect(lines).toHaveLength(0);
    expect(skipped[0]!.reason).toMatch(/too intermittent/);
  });

  it("skips an item with no supplier instead of inventing one", () => {
    const { lines, skipped } = resolveProposalLines([
      proposal({ vendorId: null, vendorName: null, currency: null }),
    ]);
    expect(lines).toHaveLength(0);
    expect(skipped[0]!.reason).toMatch(/No supplier/);
  });
});

describe("C6 cross-supplier refusal", () => {
  const batch = (vendorId: number, vendorName: string, over: Partial<{ warehouseName: string; currency: string }> = {}) => ({
    vendorId,
    vendorName,
    warehouseId: 5,
    warehouseName: over.warehouseName ?? "Main",
    currency: over.currency ?? "INR",
    lines: [],
    totalValue: "0.0000",
    totalExcessUnits: "0.0000",
    requiresApproval: false,
  });

  it("refuses a set spanning two suppliers and names both", () => {
    expect(() =>
      assertSingleSupplierSite([batch(7, "Acme"), batch(8, "Globex")], 7),
    ).toThrow(BadRequestException);
    expect(() =>
      assertSingleSupplierSite([batch(7, "Acme"), batch(8, "Globex")], 7),
    ).toThrow(/Acme, Globex/);
  });

  it("refuses a set spanning two warehouses", () => {
    expect(() =>
      assertSingleSupplierSite(
        [batch(7, "Acme"), batch(7, "Acme", { warehouseName: "North" })],
        7,
      ),
    ).toThrow(/more than one warehouse/);
  });

  it("refuses a set spanning two currencies", () => {
    expect(() =>
      assertSingleSupplierSite(
        [batch(7, "Acme"), batch(7, "Acme", { currency: "USD" })],
        7,
      ),
    ).toThrow(/more than one currency/);
  });

  it("refuses a batch attributed to a supplier the caller did not name", () => {
    // Otherwise a stale screen orders from the wrong supplier and the request
    // looks perfectly well-formed.
    expect(() => assertSingleSupplierSite([batch(8, "Globex")], 7)).toThrow(/Globex/);
  });

  it("accepts a single-supplier, single-site, single-currency batch", () => {
    expect(() => assertSingleSupplierSite([batch(7, "Acme")], 7)).not.toThrow();
  });
});
