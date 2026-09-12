import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../../db/drizzle.module";
import type { WarehouseScopeService } from "../../../stock-engine/warehouse-scope.service";
import { report, type FillRateReportDeps } from "../lib/fill-rate-report";

/**
 * The fill-rate report's two gates, which nothing asserted.
 *
 * Found by mutation when `report` moved out of `fill-rate.service.ts` into
 * `lib/fill-rate-report.ts`. Deleting the `!header` 404 and deleting the
 * `assertWarehouseVisible` call each left the whole inventory suite green
 * (172 suites, 1779 tests). `inv-ops-isolation-3.spec.ts` drives `report` but
 * only checks which org ids reached the query builder; it never looks at what
 * happens when the PO is missing or sits in a warehouse the caller is not
 * assigned to. Without the second gate a supervisor scoped to one site can read
 * the fill rate — ordered, shipped, returned and paid, per SKU — of any other.
 */

const ORG = "org-1";
const USER = "user-1";
const PO_ID = 12;
const WAREHOUSE = 9;

const HEADER = {
  id: PO_ID,
  provider: "blinkit",
  providerPoNumber: "BLK-1",
  status: "ACCEPTED",
  warehouseId: WAREHOUSE,
  poId: 40,
};

const LINES = [
  { id: 101, productVariantId: 7, providerSku: "SKU7", ean: null, quantityOrdered: "10.0000" },
];

const PAYOUTS = [
  {
    id: 1,
    payoutRef: "P-1",
    providerPoNumber: "BLK-1",
    providerSku: "SKU7",
    ean: null,
    quantity: "8.0000",
    amountPaise: 80000,
    unmatchedReason: null,
    platformPoLineId: 101,
  },
  {
    id: 2,
    payoutRef: "P-1",
    providerPoNumber: null,
    providerSku: "ZZZ",
    ean: null,
    quantity: "1.0000",
    amountPaise: 500,
    unmatchedReason: "The payout line names no purchase order",
    platformPoLineId: null,
  },
];

type LedgerRow = { product_variant_id: number; qty: string };

/**
 * `select()` answers from a queue in call order: header, lines, payouts.
 * `where()` is awaited directly by the header and payout reads and takes a
 * further `.orderBy()` on the lines read, so it awaits AND chains. No double
 * here refers to its own binding (that shape passes jest and fails tsc).
 */
function harness(opts: { selects: unknown[][]; executes?: LedgerRow[][]; gateRejects?: boolean }) {
  let s = 0;
  let e = 0;
  const select = jest.fn(() => {
    const rows = opts.selects[s++] ?? [];
    return {
      from: () => ({
        where: () => Object.assign(Promise.resolve(rows), { orderBy: () => Promise.resolve(rows) }),
      }),
    };
  });
  const execute = jest.fn(async () => opts.executes?.[e++] ?? []);
  const assertWarehouseVisible = jest.fn<Promise<void>, [string, string, number | null | undefined]>(
    async () => {
      if (opts.gateRejects) throw new NotFoundException("Not found");
    },
  );
  const deps: FillRateReportDeps = {
    db: { select, execute } as unknown as Db,
    warehouseScope: { assertWarehouseVisible } as unknown as WarehouseScopeService,
  };
  return { deps, select, execute, assertWarehouseVisible };
}

describe("fill-rate report — the gates", () => {
  it("404s a platform PO that is not in the caller's org, and reads nothing else", async () => {
    const h = harness({ selects: [[]] });

    await expect(report(h.deps, ORG, USER, { platformPoId: PO_ID })).rejects.toThrow(NotFoundException);
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.assertWarehouseVisible).not.toHaveBeenCalled();
  });

  it("asks the warehouse scope about the PO's own warehouse", async () => {
    const h = harness({ selects: [[HEADER], LINES, PAYOUTS], executes: [[], [], []] });

    await report(h.deps, ORG, USER, { platformPoId: PO_ID });
    expect(h.assertWarehouseVisible).toHaveBeenCalledWith(ORG, USER, WAREHOUSE);
  });

  it("refuses a PO in a warehouse the caller is not assigned to, before any line, ledger or payout read", async () => {
    const h = harness({ selects: [[HEADER], LINES, PAYOUTS], gateRejects: true });

    await expect(report(h.deps, ORG, USER, { platformPoId: PO_ID })).rejects.toThrow(NotFoundException);
    // Only the header read may have run: everything the report discloses comes after the gate.
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe("fill-rate report — the control", () => {
  it("reports shipped less returned against ordered, and lists the payout line it could not place", async () => {
    const h = harness({
      selects: [[HEADER], LINES, PAYOUTS],
      // received, shipped, returned — in that order, because the header has a poId.
      executes: [
        [{ product_variant_id: 7, qty: "10.0000" }],
        [{ product_variant_id: 7, qty: "9.0000" }],
        [{ product_variant_id: 7, qty: "1.0000" }],
      ],
    });

    const result = await report(h.deps, ORG, USER, { platformPoId: PO_ID });

    expect(result.lines).toEqual([
      expect.objectContaining({
        platformPoLineId: 101,
        receivedQty: "10.0000",
        shippedQty: "9.0000",
        returnedQty: "1.0000",
        acceptedQty: "8.0000",
        fillRatePct: "80.0000",
        payoutQty: "8.0000",
        payoutAmountPaise: 80000,
        // Payout and acceptance agree, so the line stays quiet.
        payoutVariance: null,
      }),
    ]);
    expect(result.unmatchedPayoutLines.map((l) => l.id)).toEqual([2]);
  });
});
