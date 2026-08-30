import { BadRequestException } from "@nestjs/common";
import {
  BlinkitInboundAdapter,
  InstamartInboundAdapter,
  ZeptoEmailInboundAdapter,
  paiseFromRupees,
} from "../quick-commerce-inbound";

/**
 * NEO-2. Fixtures, not a connected account — see the header of
 * `quick-commerce-inbound.ts`. What is asserted here is what a parser will and
 * will not accept, which is the honest thing a boundary can claim.
 */

const BLINKIT_PO = {
  po_number: "BLK-PO-88213",
  facility_code: "BLR-DARK-07",
  po_date: "2026-08-28T09:15:00.000Z",
  expected_delivery_date: "2026-09-01",
  line_items: [
    { item_code: "BLK-SKU-1", ean: "8901234567894", mrp: "125.50", pack_size: 12, quantity: 120, landing_rate: "92.40" },
    { item_code: "BLK-SKU-2", ean: "8901234567900", mrp: 60, pack_size: 24, quantity: "48", landing_rate: 41 },
  ],
};

describe("NEO-2 — Blinkit parser", () => {
  const adapter = new BlinkitInboundAdapter();

  it("reads a supplier purchase order", () => {
    const parsed = adapter.parsePurchaseOrder(BLINKIT_PO);

    expect(parsed.provider).toBe("BLINKIT");
    expect(parsed.providerPoNumber).toBe("BLK-PO-88213");
    expect(parsed.destinationRef).toBe("BLR-DARK-07");
    expect(parsed.expectedDeliveryDate).toBe("2026-09-01");
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]).toMatchObject({
      providerSku: "BLK-SKU-1",
      ean: "8901234567894",
      mrpPaise: 12550,
      packSize: 12,
      quantityOrdered: "120.0000",
    });
  });

  it("renders quantities as decimal strings, never floats", () => {
    // The platform sends JSON numbers. This is the boundary where they stop
    // being floats, because everything downstream is `numeric(18,4)`.
    const parsed = adapter.parsePurchaseOrder(BLINKIT_PO);
    for (const line of parsed.lines) {
      expect(typeof line.quantityOrdered).toBe("string");
      expect(line.quantityOrdered).toMatch(/^\d+\.\d{4}$/);
    }
  });

  it("refuses a document with no purchase-order number", () => {
    expect(() => adapter.parsePurchaseOrder({ ...BLINKIT_PO, po_number: "" })).toThrow(
      BadRequestException,
    );
  });

  it("refuses a document with no lines", () => {
    expect(() => adapter.parsePurchaseOrder({ ...BLINKIT_PO, line_items: [] })).toThrow(
      BadRequestException,
    );
  });

  it("refuses a line whose quantity is not a quantity", () => {
    expect(() =>
      adapter.parsePurchaseOrder({
        ...BLINKIT_PO,
        line_items: [{ ...BLINKIT_PO.line_items[0], quantity: "twelve" }],
      }),
    ).toThrow(/quantity/i);
  });
});

describe("NEO-2 — Instamart parser", () => {
  it("reads the same shape under different field names", () => {
    const parsed = new InstamartInboundAdapter().parsePurchaseOrder({
      purchaseOrderId: "SIM-2211",
      darkStoreId: "HYD-12",
      deliveryBy: "2026-09-03T00:00:00Z",
      items: [{ skuCode: "SIM-1", barcode: "8909999999992", mrp: "49.00", caseSize: 6, orderedQty: 30, basePrice: "36.5" }],
    });

    expect(parsed.provider).toBe("INSTAMART");
    expect(parsed.providerPoNumber).toBe("SIM-2211");
    expect(parsed.expectedDeliveryDate).toBe("2026-09-03");
    expect(parsed.lines[0]).toMatchObject({ ean: "8909999999992", mrpPaise: 4900, quantityOrdered: "30.0000" });
  });
});

describe("NEO-2 — Zepto email parser", () => {
  const adapter = new ZeptoEmailInboundAdapter();

  const email = [
    "Dear supplier,",
    "",
    "PO number: ZEP-PO-4410",
    "Store: MUM-NODE-3",
    "Deliver by: 2026-09-05",
    "",
    "sku,ean,qty,mrp,pack",
    "ZEP-1,8905555555553,60,199.00,10",
    "ZEP-2,8905555555560,24,89.50,6",
    "",
    "Regards,",
    "Zepto Supply, Mumbai, India",
  ].join("\n");

  it("reads the header lines and the table", () => {
    const parsed = adapter.parsePurchaseOrder({ body: email });

    expect(parsed.providerPoNumber).toBe("ZEP-PO-4410");
    expect(parsed.destinationRef).toBe("MUM-NODE-3");
    expect(parsed.expectedDeliveryDate).toBe("2026-09-05");
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[1]).toMatchObject({ ean: "8905555555560", quantityOrdered: "24.0000", mrpPaise: 8950 });
  });

  it("does not turn a signature block into purchase-order lines", () => {
    // "Zepto Supply, Mumbai, India" has commas. Taking the widest *consistent*
    // block rather than every line with a comma is what keeps it out.
    const parsed = adapter.parsePurchaseOrder({ body: email });
    expect(parsed.lines.map((l) => l.providerSku)).toEqual(["ZEP-1", "ZEP-2"]);
  });

  it("refuses an email with no PO number line", () => {
    expect(() =>
      adapter.parsePurchaseOrder({ body: email.replace("PO number: ZEP-PO-4410", "") }),
    ).toThrow(/PO number/);
  });

  it("refuses a table that names no quantity column", () => {
    const noQty = email.replace("sku,ean,qty,mrp,pack", "sku,ean,units,mrp,pack");
    expect(() => adapter.parsePurchaseOrder({ body: noQty })).toThrow(/quantity column/);
  });
});

describe("NEO-2 — paiseFromRupees", () => {
  it("keeps an MRP exact", () => {
    // An MRP is a legal ceiling. 125.50 must not become 125.49999999999999.
    expect(paiseFromRupees("125.50")).toBe(12550);
    expect(paiseFromRupees(125.5)).toBe(12550);
    expect(paiseFromRupees("0.05")).toBe(5);
    expect(paiseFromRupees("60")).toBe(6000);
  });

  it("returns null rather than guessing at something that is not a price", () => {
    expect(paiseFromRupees(null)).toBeNull();
    expect(paiseFromRupees("Rs. 125")).toBeNull();
    expect(paiseFromRupees("125.505")).toBeNull();
  });
});
