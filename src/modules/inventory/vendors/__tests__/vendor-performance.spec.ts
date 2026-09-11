import { NotFoundException } from "@nestjs/common";
import type { LeadTimeEstimate } from "../../replenishment/forecast/lead-time.service";
import { VendorScorecardService } from "../vendor-scorecard.service";

/**
 * C4. These used to be nine assertions about arithmetic written in the test
 * file itself — `deliveries.filter(...).length / deliveries.length` — which
 * proved the expression on the line above it and nothing about the scorecard.
 * The service could have returned any number at all and every one of them
 * passed. Every case here now calls `VendorScorecardService` and asserts what
 * it returns.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Every string inside a drizzle `SQL`, so a stub can tell the queries apart. */
function sqlText(query: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (!isRecord(node) || seen.has(node)) return;
    seen.add(node);
    for (const value of Object.values(node)) walk(value);
  };
  walk(query);
  return parts.join(" ");
}

interface StubRows {
  vendors?: Array<{ id: number; currency: string }>;
  purchaseOrders?: Array<{ vendor_id: number; currency: string; open_pos: number; spend: string }>;
  fill?: Array<{
    vendor_id: number;
    lines: number;
    lines_in_full: number;
    qty_ordered: string;
    qty_received: string;
  }>;
  onTime?: Array<{ vendor_id: number; measured: number; on_time: number }>;
  quality?: Array<{
    vendor_id: number;
    lines: number;
    rejected: number;
    discrepant: number;
    qty_received: string;
  }>;
  returns?: Array<{ vendor_id: number; lines: number; qty: string }>;
}

const NO_LEAD_TIME = (vendorId: number): LeadTimeEstimate => ({
  vendorId,
  observations: 0,
  meanDays: 0,
  stdDevDays: 0,
  p50Days: 0,
  p90Days: 0,
  reliable: false,
  note: "No receipts on record for this vendor. Any lead time used for planning is a configured assumption, not a measurement.",
});

function buildService(
  rows: StubRows,
  leadTimes: Map<number, LeadTimeEstimate> = new Map(),
): { service: VendorScorecardService; execute: jest.Mock } {
  const execute = jest.fn((query: unknown) => {
    const text = sqlText(query);
    if (text.includes("inv_vendor_return_lines")) return Promise.resolve(rows.returns ?? []);
    if (text.includes("inv_grn_lines")) return Promise.resolve(rows.quality ?? []);
    if (text.includes("inv_po_lines")) return Promise.resolve(rows.fill ?? []);
    if (text.includes("MIN(g.received_date)")) return Promise.resolve(rows.onTime ?? []);
    if (text.includes("FROM inv_vendors")) return Promise.resolve(rows.vendors ?? []);
    return Promise.resolve(rows.purchaseOrders ?? []);
  });
  const vendorLeadTimes = jest.fn((_orgId: string, vendorIds: readonly number[]) =>
    Promise.resolve(
      new Map(vendorIds.map((id) => [id, leadTimes.get(id) ?? NO_LEAD_TIME(id)])),
    ),
  );
  const service = new VendorScorecardService({ execute } as never, {
    vendorLeadTimes,
  } as never);
  return { service, execute };
}

describe("VendorScorecardService", () => {
  const ORG = "org-a";
  const VENDOR = 7;

  const busyVendor: StubRows = {
    vendors: [{ id: VENDOR, currency: "INR" }],
    purchaseOrders: [
      { vendor_id: VENDOR, currency: "INR", open_pos: 2, spend: "1000.0000" },
      { vendor_id: VENDOR, currency: "INR", open_pos: 1, spend: "250.5000" },
    ],
    fill: [
      {
        vendor_id: VENDOR,
        lines: 8,
        lines_in_full: 6,
        qty_ordered: "100.0000",
        qty_received: "85.0000",
      },
    ],
    onTime: [{ vendor_id: VENDOR, measured: 6, on_time: 5 }],
    quality: [
      { vendor_id: VENDOR, lines: 12, rejected: 3, discrepant: 2, qty_received: "85.0000" },
    ],
    returns: [{ vendor_id: VENDOR, lines: 2, qty: "7.5000" }],
  };

  it("reports the on-time rate the service computed, beside its sample", async () => {
    const { service } = buildService(busyVendor);
    const card = await service.scorecard(ORG, VENDOR);
    expect(card.onTime.percent).toBe("83.33");
    expect(card.onTime.numerator).toBe("5");
    expect(card.onTime.denominator).toBe("6");
    expect(card.onTime.sampleSize).toBe(6);
    expect(card.onTime.sufficient).toBe(false);
  });

  it("separates the line fill rate from the unit fill rate", async () => {
    // Six of eight lines complete but 85 of 100 units: an order short one item
    // is a short order, and only the line rate says so.
    const { service } = buildService(busyVendor);
    const card = await service.scorecard(ORG, VENDOR);
    expect(card.lineFill.percent).toBe("75.00");
    expect(card.unitFill.percent).toBe("85.00");
  });

  it("computes rates on the decimal strings, never a float round trip", async () => {
    const { service } = buildService(busyVendor);
    const card = await service.scorecard(ORG, VENDOR);
    // The quantities come back exactly as the database reported them; nothing
    // went through `parseFloat` on the way to the rate.
    expect(card.unitFill.numerator).toBe("85.0000");
    expect(card.unitFill.denominator).toBe("100.0000");
    expect(card.returns.percent).toBe("8.82");
    expect(card.returns.numerator).toBe("7.5000");
  });

  it("rounds a repeating rate half-up at two places", async () => {
    const { service } = buildService(busyVendor);
    const card = await service.scorecard(ORG, VENDOR);
    // 2/12 is 16.666…; truncating four places first and scaling would give
    // 16.66, which is why the multiply happens before the divide.
    expect(card.discrepancy.percent).toBe("16.67");
    expect(card.rejection.percent).toBe("25.00");
  });

  it("sums spend in the vendor's own currency and names what it left out", async () => {
    const { service } = buildService({
      ...busyVendor,
      purchaseOrders: [
        ...(busyVendor.purchaseOrders ?? []),
        { vendor_id: VENDOR, currency: "USD", open_pos: 1, spend: "90.0000" },
      ],
    });
    const card = await service.scorecard(ORG, VENDOR);
    expect(card.spend.amount).toBe("1250.5000");
    expect(card.spend.currency).toBe("INR");
    expect(card.spend.excludedCurrencies).toEqual(["USD"]);
    expect(card.notes.join(" ")).toMatch(/Spend excludes purchase orders in USD/);
    expect(card.openPoCount).toBe(4);
  });

  it("reports an unmeasurable rate as null, not as zero", async () => {
    // Zero percent and "this vendor has never delivered" are opposite claims,
    // and a scorecard that renders both as 0.0% says the worst supplier on the
    // list is flawless.
    const { service } = buildService({ vendors: [{ id: 3, currency: "INR" }] });
    const card = await service.scorecard(ORG, 3);
    expect(card.rejection.percent).toBeNull();
    expect(card.onTime.percent).toBeNull();
    expect(card.unitFill.percent).toBeNull();
    expect(card.notes.join(" ")).toMatch(/not the same as a perfect record/);
  });

  it("labels a small sample rather than presenting it as a trend", async () => {
    const { service } = buildService({
      vendors: [{ id: 3, currency: "INR" }],
      quality: [
        { vendor_id: 3, lines: 2, rejected: 1, discrepant: 0, qty_received: "10.0000" },
      ],
    });
    const card = await service.scorecard(ORG, 3);
    expect(card.rejection.percent).toBe("50.00");
    expect(card.rejection.sufficient).toBe(false);
    expect(card.notes.join(" ")).toMatch(/2 received line\(s\) and describe those lines/);
  });

  it("takes lead time from the measured estimator instead of recomputing it", async () => {
    // One estimator, not two. The scorecard used to average `sent_at` to the
    // first receipt, which is a different measurement from the lead-time report
    // one screen away.
    const measured: LeadTimeEstimate = {
      vendorId: VENDOR,
      observations: 5,
      meanDays: 11.2,
      stdDevDays: 10.7,
      p50Days: 7,
      p90Days: 30,
      reliable: true,
    };
    const { service } = buildService(busyVendor, new Map([[VENDOR, measured]]));
    const card = await service.scorecard(ORG, VENDOR);
    expect(card.leadTime).toMatchObject({
      observations: 5,
      meanDays: 11.2,
      p50Days: 7,
      p90Days: 30,
      reliable: true,
    });
  });

  it("carries the estimator's own caveat into the scorecard's notes", async () => {
    const thin: LeadTimeEstimate = {
      vendorId: VENDOR,
      observations: 2,
      meanDays: 4,
      stdDevDays: 1.4,
      p50Days: 3,
      p90Days: 5,
      reliable: false,
      note: "Only 2 receipt(s); the spread here is noise rather than a measured distribution.",
    };
    const { service } = buildService(busyVendor, new Map([[VENDOR, thin]]));
    const card = await service.scorecard(ORG, VENDOR);
    expect(card.leadTime.reliable).toBe(false);
    expect(card.notes.join(" ")).toMatch(/noise rather than a measured distribution/);
  });

  it("404s a vendor in another tenant rather than confirming it exists", async () => {
    const { service } = buildService({ vendors: [] });
    await expect(service.scorecard(ORG, 999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("scores a page of vendors in the same number of queries as one", async () => {
    // The N+1 measurement. The supplier-delay briefing scores every delayed
    // vendor at once, and the old per-vendor read was seven queries each.
    const one = buildService({ vendors: [{ id: 1, currency: "INR" }] });
    await one.service.scorecardsFor(ORG, [1]);
    const queriesForOne = one.execute.mock.calls.length;

    const many = buildService({
      vendors: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, currency: "INR" })),
    });
    const cards = await many.service.scorecardsFor(
      ORG,
      Array.from({ length: 50 }, (_, i) => i + 1),
    );

    expect(cards.size).toBe(50);
    expect(many.execute.mock.calls.length).toBe(queriesForOne);
    expect(queriesForOne).toBe(6);
  });

  it("asks the estimator once for the whole page, not once per vendor", async () => {
    const vendorLeadTimes = jest.fn((_orgId: string, ids: readonly number[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, NO_LEAD_TIME(id)]))),
    );
    const execute = jest.fn(() => Promise.resolve([]));
    const service = new VendorScorecardService({ execute } as never, {
      vendorLeadTimes,
    } as never);

    await service.scorecardsFor(ORG, [1, 2, 3, 4, 5]);
    expect(vendorLeadTimes).toHaveBeenCalledTimes(1);
    expect(vendorLeadTimes).toHaveBeenCalledWith(ORG, [1, 2, 3, 4, 5]);
  });

  it("does not touch the database for an empty vendor list", async () => {
    const { service, execute } = buildService({});
    const cards = await service.scorecardsFor(ORG, []);
    expect(cards.size).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  /*
   * The tenant predicate, which nothing checked.
   *
   * `VendorScorecardService` is in no tenant-isolation sweep — `inv-ops-isolation-4`
   * covers nine inventory services and not this one — and the method this
   * replaced, `InvVendorsService.getVendorPerformance`, had a per-PO receipt
   * lookup carrying no `org_id` predicate at all. That is the defect the
   * service's own header names, and the only thing standing between it and a
   * repeat was that the six queries happened to be written correctly.
   *
   * Asserted over every captured query rather than one, because the failure
   * mode is one read out of six losing its predicate in an edit, and five
   * correct queries do not make the sixth safe.
   */
  it("scopes every aggregate to the asking tenant", async () => {
    const { service, execute } = buildService(busyVendor);
    await service.scorecardsFor(ORG, [VENDOR]);

    expect(execute.mock.calls).toHaveLength(6);
    for (const [query] of execute.mock.calls) {
      const text = sqlText(query);
      expect(text).toContain("org_id");
      // The bound value, not just the column name: a query naming `org_id` in a
      // JOIN condition while filtering on none would otherwise pass.
      expect(text).toContain(ORG);
    }
  });

  it("scopes the evidence list and its count to the asking tenant too", async () => {
    // `deliveries` is the drill-down behind the rates and is reached by its own
    // route, so it needs the predicate in its own right.
    const execute = jest.fn(() => Promise.resolve([]));
    const service = new VendorScorecardService({ execute } as never, {
      vendorLeadTimes: jest.fn(() => Promise.resolve(new Map())),
    } as never);

    await service.deliveries(ORG, VENDOR, { page: 1, limit: 20 } as never);

    expect(execute.mock.calls).toHaveLength(2);
    for (const [query] of execute.mock.calls) {
      expect(sqlText(query)).toContain(ORG);
    }
  });
});
