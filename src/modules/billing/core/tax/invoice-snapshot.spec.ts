import { determineTax } from "./tax-determination";
import {
  invoiceFingerprint,
  renderInvoice,
  reproduces,
  snapshotProblems,
  type InvoiceSnapshot,
} from "./invoice-snapshot";

function snapshotFor(overrides: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  const tax = determineTax(100_000, { country: "IN", state: "KA" });

  return {
    invoiceNumber: "INV-2026-000042",
    issuedAt: "2026-08-26T10:00:00.000Z",
    currency: "INR",
    seller: { name: "StreamlineOS", country: "IN", taxId: "29ABCDE1234F1Z5" },
    buyer: {
      name: "Acme Pvt Ltd",
      country: "IN",
      state: "KA",
      taxId: "29ZYXWV9876G1Z2",
      addressLines: ["4th Floor", "Bengaluru 560001"],
    },
    lines: [
      { description: "Professional plan (monthly)", quantity: 1, unitAmountMinor: 100_000, amountMinor: 100_000 },
    ],
    tax,
    netMinor: tax.netMinor,
    taxMinor: tax.taxMinor,
    grossMinor: tax.grossMinor,
    ...overrides,
  };
}

/**
 * The bytes this fixture must render to, and its fingerprint.
 *
 * Committed rather than computed, and that is the whole point. The three cases
 * this replaced compared `renderInvoice(s)` to `renderInvoice(s)` and
 * `invoiceFingerprint(s)` to itself — same function, same process, same tick, so
 * they held however the renderer changed and could not fail. An invoice that
 * reproduces is a claim about a document issued in the past, which nothing
 * computed inside this run can stand in for.
 *
 * If a change to `renderInvoice` fails these, that is the test working. Do not
 * re-derive the constants to make it pass: an invoice already sent to a customer
 * renders to the bytes below, and a deliberate format change means the old ones
 * must still reproduce from their stored fingerprint. Add a case for the new
 * shape instead.
 */
const GOLDEN_DOCUMENT = [
  "INVOICE INV-2026-000042",
  "Issued: 2026-08-26T10:00:00.000Z",
  "Currency: INR",
  "",
  "From: StreamlineOS (IN)",
  "      29ABCDE1234F1Z5",
  "",
  "To:   Acme Pvt Ltd (IN)",
  "      4th Floor",
  "      Bengaluru 560001",
  "      29ZYXWV9876G1Z2",
  "",
  "Professional plan (monthly) \u00d7 1 @ 1000.00 = 1000.00",
  "",
  "Net:   1000.00",
  "CGST (9.00%): 90.00",
  "SGST (9.00%): 90.00",
  "Tax:   180.00",
  "Total: 1180.00",
  "",
  "Supply within the seller's state.",
  "Rates version: 2026-08-26",
].join("\n");

const GOLDEN_FINGERPRINT =
  "dfc86986d786950ae929f5b029223dd5c8655f3c3acacd6637a7e96726ffcfeb";

describe("reproducibility", () => {
  it("renders the bytes it rendered when the invoice was issued", () => {
    expect(renderInvoice(snapshotFor())).toBe(GOLDEN_DOCUMENT);
  });

  it("fingerprints to the value stored against the issued invoice", () => {
    expect(invoiceFingerprint(snapshotFor())).toBe(GOLDEN_FINGERPRINT);
  });

  it("proves an invoice still reproduces, against a fingerprint from before this run", () => {
    // The fingerprint is the committed one, not one computed a line earlier --
    // otherwise both sides move together and the check cannot fail.
    expect(reproduces(snapshotFor(), GOLDEN_FINGERPRINT)).toBe(true);
  });

  it("detects a snapshot that has been altered since issue", () => {
    const snapshot = snapshotFor();
    const issued = invoiceFingerprint(snapshot);
    const altered = snapshotFor({ grossMinor: snapshot.grossMinor + 1 });

    expect(reproduces(altered, issued)).toBe(false);
  });

  it("does not read a clock, so a render tomorrow matches one today", () => {
    // issuedAt is captured, never derived. A renderer that reached for the
    // current time would produce a different invoice every day.
    expect(renderInvoice(snapshotFor())).toContain("2026-08-26T10:00:00.000Z");
  });

  it("formats money without Intl, whose output moves with the runtime's ICU", () => {
    // An invoice rendered on a new Node release would otherwise differ from the
    // one the customer received, invisibly.
    const rendered = renderInvoice(snapshotFor());

    expect(rendered).toContain("1000.00");
    expect(rendered).not.toMatch(/[₹$€£]/);
    expect(rendered).not.toContain("1,000");
  });

  it("prints every tax head with its rate", () => {
    const rendered = renderInvoice(snapshotFor());

    expect(rendered).toContain("CGST (9.00%): 90.00");
    expect(rendered).toContain("SGST (9.00%): 90.00");
    expect(rendered).toContain("Total: 1180.00");
  });

  it("carries the rates version onto the invoice itself", () => {
    expect(renderInvoice(snapshotFor())).toContain("Rates version:");
  });

  it("prints the reason, so the treatment is legible to the reader", () => {
    const rendered = renderInvoice(
      snapshotFor({ tax: determineTax(100_000, { country: "DE", taxId: "DE123456789" }) }),
    );

    expect(rendered).toContain("accounts for the tax");
  });
});

describe("snapshotProblems", () => {
  it("accepts a snapshot whose arithmetic agrees", () => {
    expect(snapshotProblems(snapshotFor())).toEqual([]);
  });

  it("catches a total that does not match its lines", () => {
    // A snapshot whose totals disagree with its lines is worse than none: it
    // reproduces perfectly, and reproduces something wrong.
    const problems = snapshotProblems(snapshotFor({ netMinor: 99_000 }));
    expect(problems.join(" ")).toContain("lines total");
  });

  it("catches tax heads that do not sum to the tax line", () => {
    const snapshot = snapshotFor();
    const problems = snapshotProblems({ ...snapshot, taxMinor: snapshot.taxMinor + 1 });

    expect(problems.join(" ")).toContain("tax heads total");
  });

  it("catches a gross that is not net plus tax", () => {
    const problems = snapshotProblems(snapshotFor({ grossMinor: 1 }));
    expect(problems.join(" ")).toContain("net plus tax");
  });

  it("catches a line that does not multiply out", () => {
    const problems = snapshotProblems(
      snapshotFor({
        lines: [
          { description: "Seats", quantity: 3, unitAmountMinor: 100_000, amountMinor: 100_000 },
        ],
      }),
    );

    expect(problems.join(" ")).toContain("does not multiply out");
  });

  it("catches a determination made against a different net", () => {
    // The tax was computed on one number and the invoice states another, which
    // is exactly the discrepancy an auditor finds.
    const snapshot = snapshotFor();
    const problems = snapshotProblems({
      ...snapshot,
      tax: determineTax(50_000, { country: "IN", state: "KA" }),
    });

    expect(problems.join(" ")).toContain("different net");
  });

  it("catches a non-integer amount", () => {
    expect(snapshotProblems(snapshotFor({ netMinor: 1000.5 })).join(" ")).toContain(
      "integer minor units",
    );
  });
});

describe("across currencies", () => {
  it("renders a euro invoice with reverse charge and no tax", () => {
    const tax = determineTax(190_000, { country: "DE", taxId: "DE123456789" });
    const rendered = renderInvoice(
      snapshotFor({
        currency: "EUR",
        buyer: {
          name: "Beispiel GmbH",
          country: "DE",
          taxId: "DE123456789",
          addressLines: ["Berlin"],
        },
        lines: [
          { description: "Professional plan (monthly)", quantity: 1, unitAmountMinor: 190_000, amountMinor: 190_000 },
        ],
        tax,
        netMinor: tax.netMinor,
        taxMinor: tax.taxMinor,
        grossMinor: tax.grossMinor,
      }),
    );

    expect(rendered).toContain("Currency: EUR");
    expect(rendered).toContain("Tax:   0.00");
    expect(rendered).toContain("Total: 1900.00");
  });
});
