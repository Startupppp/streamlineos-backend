/**
 * Tax-invoice and credit-note PDF.
 *
 * Plain by design. `00-build-order.md` puts invoice theming, logo upload and
 * pretty layouts explicitly out of v1; what is *in* v1 is a document that
 * carries every field `05-prd-gst-india.md` M6 lists as a tax-invoice print
 * field and whose figures line up. So: one typeface pair, hairline rules, and
 * every number in Courier so the columns are a real grid rather than an
 * approximation.
 *
 * Pure, like `hr/payroll/lib/payslip-pdf.ts`: it takes a plain data object —
 * never an ORM row — and returns a `Buffer`. No service, no database, no clock
 * unless the caller passes one. That is what makes it unit-testable.
 *
 * Money arrives as **integer minor units** and is formatted through the
 * kernel's `toDecimalString`, so nothing here ever divides by 100.
 *
 * The pieces sit beside this file: the data shape in `invoice-pdf.types.ts`,
 * formatting in `invoice-pdf-format.ts`, the page grid and draw primitives in
 * `invoice-pdf-canvas.ts`, the header blocks in `invoice-pdf-blocks.ts`, and
 * the line table and totals in `invoice-pdf-table.ts`.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { drawMetaBlock, drawPartyBlock } from "./invoice-pdf-blocks";
import {
  CONTENT_W,
  GREY,
  MARGIN,
  PAGE_H,
  PAGE_W,
  RIGHT,
  SMALL,
  BODY_FLOOR,
  drawRight,
  drawRule,
  drawTableHead,
  drawText,
  newPage,
  titleFor,
  type Canvas,
  type Fonts,
} from "./invoice-pdf-canvas";
import { formatMinor, wrap } from "./invoice-pdf-format";
import { drawLineRows, drawTaxSummaryAndTotals } from "./invoice-pdf-table";
import type { InvoicePdfData } from "./invoice-pdf.types";

export { sanitizeForPdf } from "./invoice-pdf-format";
export type {
  InvoicePdfData,
  InvoicePdfLine,
  InvoicePdfParty,
  InvoicePdfTaxComponent,
} from "./invoice-pdf.types";

/* ------------------------------------------------------------------ entry */

export async function generateInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    text: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
    monoBold: await doc.embedFont(StandardFonts.CourierBold),
  };

  const canvas: Canvas = {
    doc,
    page: doc.addPage([PAGE_W, PAGE_H]),
    fonts,
    y: PAGE_H - MARGIN,
  };

  /**
   * A credit note is a signed invoice, so it is the same layout with the
   * amounts carrying a minus. Printing it positive is how a credit note ends
   * up added to a customer balance instead of subtracted from it.
   */
  const sign = data.documentType === "CREDIT_NOTE" ? -1 : 1;
  const amount = (minor: number): string => formatMinor(sign * minor, data.currency);

  /* -- title ------------------------------------------------------------ */
  const title = titleFor(data.documentType);
  const titleW = fonts.bold.widthOfTextAtSize(title, 16);
  drawText(canvas.page, title, PAGE_W / 2 - titleW / 2, canvas.y - 14, fonts.bold, 16);
  canvas.y -= 20;

  const subtitle =
    data.documentType === "CREDIT_NOTE"
      ? "Amounts are shown negative: this note reduces the amount receivable."
      : data.reverseCharge
        ? "Tax payable under reverse charge."
        : "";
  if (subtitle) {
    const w = fonts.text.widthOfTextAtSize(subtitle, SMALL);
    drawText(canvas.page, subtitle, PAGE_W / 2 - w / 2, canvas.y - 8, fonts.text, SMALL, GREY);
  }
  canvas.y -= 18;
  drawRule(canvas.page, canvas.y, MARGIN, RIGHT, 1);
  canvas.y -= 14;

  /* -- seller, buyer, document ------------------------------------------ */
  const leftW = 250;
  const metaX = MARGIN + CONTENT_W - 200;

  const blockTop = canvas.y;
  const afterSeller = drawPartyBlock(canvas, "SUPPLIER", data.seller, MARGIN, leftW);
  canvas.y = blockTop;
  const afterMeta = drawMetaBlock(canvas, data, metaX, 200);

  canvas.y = Math.min(afterSeller, afterMeta) - 6;
  drawRule(canvas.page, canvas.y);
  canvas.y -= 12;

  const afterBuyer = drawPartyBlock(canvas, "BILL TO", data.buyer, MARGIN, leftW);
  canvas.y = afterBuyer - 6;
  drawRule(canvas.page, canvas.y);
  canvas.y -= 14;

  /* -- lines ------------------------------------------------------------- */
  drawTableHead(canvas);
  drawLineRows(canvas, data, amount);

  /* -- tax summary and totals -------------------------------------------- */
  drawTaxSummaryAndTotals(canvas, data, amount);

  /* -- footer ------------------------------------------------------------- */
  if (canvas.y < BODY_FLOOR) newPage(canvas, data);
  drawRule(canvas.page, canvas.y);
  canvas.y -= 12;
  if (data.memo) {
    for (const line of wrap(`Notes: ${data.memo}`, fonts.text, SMALL, CONTENT_W)) {
      drawText(canvas.page, line, MARGIN, canvas.y, fonts.text, SMALL);
      canvas.y -= 9;
    }
    canvas.y -= 4;
  }

  const stamp = (data.generatedAt ?? new Date()).toISOString().replace("T", " ").slice(0, 19);
  const footer = `Computer-generated ${data.documentType === "CREDIT_NOTE" ? "credit note" : "tax invoice"} - no signature required.  Generated ${stamp} UTC.`;
  for (const p of canvas.doc.getPages()) {
    drawText(p, footer, MARGIN, MARGIN - 12, fonts.text, SMALL - 0.5, GREY);
  }
  const pages = canvas.doc.getPages();
  pages.forEach((p, index) => {
    drawRight(
      p,
      `Page ${index + 1} of ${pages.length}`,
      RIGHT,
      MARGIN - 12,
      fonts.text,
      SMALL - 0.5,
      GREY,
    );
  });

  return Buffer.from(await doc.save());
}
