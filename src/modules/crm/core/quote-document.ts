import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { StorageService } from "../../storage/storage.service";

export interface QuoteDocumentLine {
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly taxRate?: number;
}

export interface QuoteDocumentInput {
  readonly quoteNumber: string;
  readonly subject: string;
  readonly currency: string;
  readonly validUntil: string;
  readonly lineItems: readonly QuoteDocumentLine[];
  readonly totalAmount: number;
  readonly taxAmount: number;
  readonly netAmount: number;
}

/** Where an organisation's generated quotes live. */
const FOLDER = "crm-quotes";

/**
 * The storage key for one quote's document.
 *
 * Organisation first, so a listing is scoped by prefix and one tenant's quote
 * can never land under another's. Deterministic on the quote, so regenerating —
 * after a line item changes, or after a failed send — replaces the document
 * rather than leaving two versions where a customer might be sent the older one.
 */
export function quoteDocumentKey(
  organizationId: string,
  quoteId: number,
  quoteNumber: string,
): string {
  const safe = (value: string): string =>
    value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.{2,}/g, ".").replace(/^\.+/, "");
  return `${safe(organizationId)}/${quoteId}-${safe(quoteNumber)}.pdf`;
}

/**
 * Formats money in the quote's own currency, as an ISO code rather than a symbol.
 *
 * `Intl` rather than a symbol table, because the alternative is the bug this
 * codebase has already shipped three times — a hardcoded `₹` on a tenant who
 * does not bill in rupees, which is a wrong number wearing a right symbol.
 * `en-IN` grouping stays for the lakh/crore reading the primary market expects;
 * the *currency* is the quote's.
 *
 * **`currencyDisplay: "code"` is not a style choice.** pdf-lib's standard fonts
 * are WinAnsi, which has no `₹` — rendering the symbol throws
 * `WinAnsi cannot encode "₹" (0x20b9)`, so the very first quote an Indian
 * tenant generated would have failed rather than looked wrong. The alternatives
 * were embedding a Unicode font per deployment or writing "INR 1,26,000.00",
 * and a formal quote naming the currency in full is what an international
 * customer wants anyway.
 */
function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    currencyDisplay: "code",
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * The quote a customer is actually sent.
 *
 * Every figure here is passed in. Nothing multiplies a quantity by a unit price
 * or re-derives a total — `quote-draft.ts` owns that, and a document that
 * recomputed would be a second opinion about what was quoted, discoverable only
 * when it disagreed.
 */
export async function renderQuotePdf(quote: QuoteDocumentInput): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.42, 0.44, 0.48);

  let y = 790;
  const line = (text: string, size = 10, f = font, colour = ink): void => {
    page.drawText(text, { x: 48, y, size, font: f, color: colour });
    y -= size + 6;
  };

  line(`Quote ${quote.quoteNumber}`, 20, bold);
  line(quote.subject, 12, font, muted);
  line(`Valid until ${quote.validUntil}`, 10, font, muted);
  y -= 12;

  line("Description", 10, bold);
  for (const item of quote.lineItems) {
    const tax = item.taxRate === undefined ? "" : `  (tax ${String(item.taxRate)}%)`;
    line(
      `${item.description}  ×${String(item.quantity)}  @ ${money(item.unitPrice, quote.currency)}${tax}`,
    );
  }

  y -= 12;
  line(`Subtotal   ${money(quote.totalAmount, quote.currency)}`);
  line(`Tax        ${money(quote.taxAmount, quote.currency)}`);
  line(`Total      ${money(quote.netAmount, quote.currency)}`, 12, bold);

  return Buffer.from(await pdf.save());
}

export interface StoredQuoteDocument {
  readonly key: string;
  readonly sizeBytes: number;
}

/**
 * Renders the quote and puts it in the organisation's own region.
 *
 * The organisation goes to `uploadFile` first — that is ticket 03's seam, and
 * it is what keeps a customer's quote in the same region as the deal it came
 * from rather than in the deployment's primary bucket.
 */
export async function storeQuoteDocument(
  storage: StorageService,
  organizationId: string,
  quoteId: number,
  quote: QuoteDocumentInput,
): Promise<StoredQuoteDocument> {
  const bytes = await renderQuotePdf(quote);
  const key = quoteDocumentKey(organizationId, quoteId, quote.quoteNumber);

  await storage.uploadFile(organizationId, bytes, FOLDER, key, "application/pdf");

  return { key, sizeBytes: bytes.length };
}
