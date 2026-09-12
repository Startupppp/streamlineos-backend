/**
 * The page grid of the tax-invoice PDF and the primitives everything is drawn
 * with. Every string reaches the page through `sanitizeForPdf`.
 */
import { rgb, type PDFDocument, type PDFFont, type PDFPage } from "pdf-lib";
import { sanitizeForPdf } from "./invoice-pdf-format";
import type { InvoicePdfData } from "./invoice-pdf.types";

/* -------------------------------------------------------------- constants */

export const PAGE_W = 595;
export const PAGE_H = 842;
export const MARGIN = 36;
export const CONTENT_W = PAGE_W - MARGIN * 2;
export const RIGHT = PAGE_W - MARGIN;
/** Rows stop here and roll onto a new page. */
export const BODY_FLOOR = 96;

export const BLACK = rgb(0, 0, 0);
export const GREY = rgb(0.35, 0.35, 0.35);
export const RULE = rgb(0.65, 0.65, 0.65);
export const BAND = rgb(0.92, 0.92, 0.92);

export const BODY = 8;
export const SMALL = 7;

/**
 * The line grid. Widths sum to `CONTENT_W`, so a column never drifts and the
 * figures underneath a heading are the figures for that heading.
 */
export const COLS = {
  no: 16,
  description: 148,
  hsn: 50,
  qty: 36,
  rate: 56,
  taxable: 60,
  taxPct: 32,
  tax: 60,
  amount: 65,
} as const;

const COL_ORDER = [
  "no",
  "description",
  "hsn",
  "qty",
  "rate",
  "taxable",
  "taxPct",
  "tax",
  "amount",
] as const;

export type ColKey = (typeof COL_ORDER)[number];

/** Left edge of each column, computed once from the widths. */
export const COL_X: Record<ColKey, number> = (() => {
  const out = {} as Record<ColKey, number>;
  let x = MARGIN;
  for (const key of COL_ORDER) {
    out[key] = x;
    x += COLS[key];
  }
  return out;
})();

/* -------------------------------------------------------------- rendering */

export interface Fonts {
  text: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
  monoBold: PDFFont;
}

export interface Canvas {
  doc: PDFDocument;
  page: PDFPage;
  fonts: Fonts;
  y: number;
}

export function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  color = BLACK,
): void {
  page.drawText(sanitizeForPdf(text), { x, y, size, font, color });
}

/** The whole reason figures are legible: measured, then placed from the right. */
export function drawRight(
  page: PDFPage,
  text: string,
  rightEdge: number,
  y: number,
  font: PDFFont,
  size: number,
  color = BLACK,
): void {
  const clean = sanitizeForPdf(text);
  page.drawText(clean, {
    x: rightEdge - font.widthOfTextAtSize(clean, size),
    y,
    size,
    font,
    color,
  });
}

export function drawRule(
  page: PDFPage,
  y: number,
  from = MARGIN,
  to = RIGHT,
  thickness = 0.5,
): void {
  page.drawLine({ start: { x: from, y }, end: { x: to, y }, thickness, color: RULE });
}

export function colRight(key: ColKey): number {
  return COL_X[key] + COLS[key] - 3;
}

export function drawTableHead(canvas: Canvas): void {
  const { page, fonts } = canvas;
  canvas.page.drawRectangle({
    x: MARGIN,
    y: canvas.y - 4,
    width: CONTENT_W,
    height: 14,
    color: BAND,
  });
  const baseline = canvas.y + 1;
  drawText(page, "#", COL_X.no + 2, baseline, fonts.bold, SMALL);
  drawText(page, "Description", COL_X.description + 2, baseline, fonts.bold, SMALL);
  drawText(page, "HSN/SAC", COL_X.hsn + 2, baseline, fonts.bold, SMALL);
  drawRight(page, "Qty", colRight("qty"), baseline, fonts.bold, SMALL);
  drawRight(page, "Unit price", colRight("rate"), baseline, fonts.bold, SMALL);
  drawRight(page, "Taxable", colRight("taxable"), baseline, fonts.bold, SMALL);
  drawRight(page, "Tax %", colRight("taxPct"), baseline, fonts.bold, SMALL);
  drawRight(page, "Tax", colRight("tax"), baseline, fonts.bold, SMALL);
  drawRight(page, "Amount", colRight("amount"), baseline, fonts.bold, SMALL);
  canvas.y -= 10;
  drawRule(page, canvas.y);
  canvas.y -= 11;
}

export function newPage(canvas: Canvas, data: InvoicePdfData): void {
  canvas.page = canvas.doc.addPage([PAGE_W, PAGE_H]);
  canvas.y = PAGE_H - MARGIN;
  drawText(
    canvas.page,
    `${titleFor(data.documentType)} ${data.documentNumber} (continued)`,
    MARGIN,
    canvas.y - 8,
    canvas.fonts.bold,
    9,
  );
  canvas.y -= 22;
  drawTableHead(canvas);
}

export function titleFor(documentType: InvoicePdfData["documentType"]): string {
  return documentType === "CREDIT_NOTE" ? "CREDIT NOTE" : "TAX INVOICE";
}
