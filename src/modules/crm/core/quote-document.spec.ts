import { renderQuotePdf, quoteDocumentKey, storeQuoteDocument } from "./quote-document";
import type { StorageService } from "../../storage/storage.service";

/**
 * The quote as a document, stored where the tenant's other data lives.
 *
 * `quote-draft.ts` already computes the figures — no model multiplies a
 * quantity by a unit price. This turns those figures into the artefact a
 * customer is actually sent, and puts it in the organisation's own region
 * through ticket 03's accessor.
 */
describe("quote documents", () => {
  const quote = {
    quoteNumber: "Q-2026-001",
    subject: "Warehouse racking, phase one",
    currency: "INR",
    validUntil: "2026-09-30",
    lineItems: [
      { description: "Pallet racking bay", quantity: 12, unitPrice: 8_500, taxRate: 18 },
      { description: "Installation", quantity: 1, unitPrice: 24_000, taxRate: 18 },
    ],
    totalAmount: 126_000,
    taxAmount: 22_680,
    netAmount: 148_680,
  };

  it("renders a real PDF", async () => {
    const bytes = await renderQuotePdf(quote);

    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(500);
  });

  /**
   * The customer's currency, not the deployment's. A quote priced in rupees for
   * a tenant billing in dirhams is a wrong number wearing a right symbol, and
   * this codebase has already shipped that bug on three other surfaces.
   */
  it("prices in the quote's own currency", async () => {
    const inr = await renderQuotePdf(quote);
    const aed = await renderQuotePdf({ ...quote, currency: "AED" });

    expect(inr.equals(aed)).toBe(false);
  });

  it("puts a quote's document on the same key every time, so regenerating replaces it", () => {
    const a = quoteDocumentKey("org-1", 42, "Q-2026-001");
    const b = quoteDocumentKey("org-1", 42, "Q-2026-001");

    expect(a).toBe(b);
    expect(a).toContain("org-1");
  });

  it("does not let one tenant's quote land under another's prefix", () => {
    const mine = quoteDocumentKey("org-1", 42, "Q-2026-001");
    const theirs = quoteDocumentKey("org-2", 42, "Q-2026-001");

    expect(mine).not.toBe(theirs);
  });

  it("stores the document in the organisation's own region", async () => {
    const calls: { orgId: string; key: string }[] = [];
    const storage = {
      uploadFile: async (orgId: string, _buf: Buffer, _folder: string, key: string) => {
        calls.push({ orgId, key });
        return { url: "", key, size: 0, mimeType: "application/pdf" };
      },
    } as unknown as StorageService;

    const stored = await storeQuoteDocument(storage, "org-1", 42, quote);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.orgId).toBe("org-1");
    expect(stored.key).toBe(quoteDocumentKey("org-1", 42, quote.quoteNumber));
  });
});
