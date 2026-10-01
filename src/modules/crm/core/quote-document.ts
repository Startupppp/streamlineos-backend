import { StandardFonts, rgb } from "pdf-lib";
import { renderBoundedPdf } from "../../../common/documents/pdf-render-kernel";
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

export function quoteDocumentKey(
  organizationId: string,
  quoteId: number,
  quoteNumber: string,
): string {
  const safe = (value: string): string =>
    value
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^\.+/, "");
  return `${safe(organizationId)}/${quoteId}-${safe(quoteNumber)}.pdf`;
}

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    currencyDisplay: "code",
    maximumFractionDigits: 2,
  }).format(amount);
}

export async function renderQuotePdf(
  quote: QuoteDocumentInput,
): Promise<Buffer> {
  return renderBoundedPdf(async ({ document: pdf, addPage, checkpoint }) => {
    checkpoint(
      quote.subject.length +
        quote.quoteNumber.length +
        quote.lineItems.reduce(
          (total, item) => total + item.description.length + 1,
          0,
        ),
    );
    const page = addPage([595, 842]);
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
      checkpoint();
      const tax =
        item.taxRate === undefined ? "" : `  (tax ${String(item.taxRate)}%)`;
      line(
        `${item.description}  ×${String(item.quantity)}  @ ${money(item.unitPrice, quote.currency)}${tax}`,
      );
    }

    y -= 12;
    line(`Subtotal   ${money(quote.totalAmount, quote.currency)}`);
    line(`Tax        ${money(quote.taxAmount, quote.currency)}`);
    line(`Total      ${money(quote.netAmount, quote.currency)}`, 12, bold);
  });
}

export interface StoredQuoteDocument {
  readonly key: string;
  readonly sizeBytes: number;
}

export async function storeQuoteDocument(
  storage: StorageService,
  organizationId: string,
  quoteId: number,
  quote: QuoteDocumentInput,
): Promise<StoredQuoteDocument> {
  const bytes = await renderQuotePdf(quote);
  const key = quoteDocumentKey(organizationId, quoteId, quote.quoteNumber);

  await storage.uploadFile(
    organizationId,
    bytes,
    FOLDER,
    key,
    "application/pdf",
  );

  return { key, sizeBytes: bytes.length };
}
