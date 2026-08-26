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
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { money, toDecimalString } from "../../kernel/money";

/* ------------------------------------------------------------------ types */

/** A tax component as the engine froze it — CGST/SGST/IGST/CESS/VAT/…. */
export interface InvoicePdfTaxComponent {
  component: string;
  jurisdiction?: string | null;
  /** Basis points: 1800 = 18.00%. */
  rateBp: number;
  taxableMinor: number;
  taxMinor: number;
}

export interface InvoicePdfLine {
  lineNo: number;
  description: string;
  /** HSN/SAC in India, generic commodity code elsewhere. M6 requires it. */
  commodityCode: string | null;
  /** Thousandths, so 2.5 hours is 2500. */
  quantityMilli: number;
  unit: string | null;
  unitPriceMinor: number;
  discountMinor: number;
  /** Taxable value of the line, after discount. */
  taxableMinor: number;
  taxMinor: number;
  grossMinor: number;
  taxComponents: InvoicePdfTaxComponent[];
}

export interface InvoicePdfParty {
  name: string;
  legalName?: string | null;
  /** GSTIN / VAT id / tax id. Null prints as "Unregistered". */
  taxRegistrationNumber: string | null;
  /** The label above that number — "GSTIN" for India, "VAT No." elsewhere. */
  taxRegistrationLabel?: string | null;
  addressLines: string[];
  stateCode?: string | null;
  countryCode?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface InvoicePdfData {
  documentType: "INVOICE" | "CREDIT_NOTE";
  /** Never null: only a posted document has a number, and only it gets a PDF. */
  documentNumber: string;
  documentDate: string;
  dueDate?: string | null;
  currency: string;

  seller: InvoicePdfParty;
  buyer: InvoicePdfParty;

  /** Place of supply — the POS state code in India. M6 requires it. */
  placeOfSupply?: string | null;
  /** M6 requires the document to say whether reverse charge applies. */
  reverseCharge: boolean;
  supplyNature?: string | null;

  /** A credit note points back at the invoice it corrects. */
  originalDocumentNumber?: string | null;
  originalDocumentDate?: string | null;

  lines: InvoicePdfLine[];
  /** Components rolled up across lines, for the summary table. */
  taxSummary: InvoicePdfTaxComponent[];

  netMinor: number;
  taxMinor: number;
  roundingMinor: number;
  grossMinor: number;

  memo?: string | null;
  reference?: string | null;
  /** Injectable so a test renders a byte-stable document. */
  generatedAt?: Date;
}

/* -------------------------------------------------------------- constants */

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;
const RIGHT = PAGE_W - MARGIN;
/** Rows stop here and roll onto a new page. */
const BODY_FLOOR = 96;

const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.35, 0.35, 0.35);
const RULE = rgb(0.65, 0.65, 0.65);
const BAND = rgb(0.92, 0.92, 0.92);

const BODY = 8;
const SMALL = 7;

/**
 * The line grid. Widths sum to `CONTENT_W`, so a column never drifts and the
 * figures underneath a heading are the figures for that heading.
 */
const COLS = {
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

type ColKey = (typeof COL_ORDER)[number];

/** Left edge of each column, computed once from the widths. */
const COL_X: Record<ColKey, number> = (() => {
  const out = {} as Record<ColKey, number>;
  let x = MARGIN;
  for (const key of COL_ORDER) {
    out[key] = x;
    x += COLS[key];
  }
  return out;
})();

/* ------------------------------------------------------------ formatting */

/**
 * WinAnsi is all a standard PDF font can encode, and `drawText` throws on
 * anything else. Customer names are free text, so fold the characters that
 * actually turn up and replace the rest rather than failing to produce an
 * invoice.
 */
const TRANSLITERATE: Record<string, string> = {
  "₹": "Rs.",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  " ": " ",
  "•": "-",
};

export function sanitizeForPdf(value: string): string {
  let out = "";
  for (const char of value) {
    const mapped = TRANSLITERATE[char];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code === 9) {
      out += " ";
    } else if (code < 32 || (code >= 127 && code < 160) || code > 255) {
      out += "?";
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Minor units to a display string, through the kernel.
 *
 * A currency the kernel has no scale for would otherwise throw mid-render and
 * lose the whole document; fall back to a two-place scale, still via
 * `toDecimalString`, so this file never performs the division itself.
 */
function formatMinor(minor: number, currency: string): string {
  try {
    return toDecimalString(money(minor, currency));
  } catch {
    return toDecimalString(money(minor, "USD"));
  }
}

/** 1800 -> "18.00%". Integer maths; basis points are already scaled by 100. */
function formatRate(rateBp: number): string {
  const negative = rateBp < 0;
  const abs = Math.abs(Math.trunc(rateBp));
  const whole = Math.trunc(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}%`;
}

/** Thousandths to a trimmed decimal: 2500 -> "2.5", 1000 -> "1". */
function formatQuantity(quantityMilli: number): string {
  const negative = quantityMilli < 0;
  const abs = Math.abs(Math.trunc(quantityMilli));
  const whole = Math.trunc(abs / 1000);
  const fraction = String(abs % 1000).padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = sanitizeForPdf(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    // A single word longer than the column is chopped rather than overflowing.
    let remainder = word;
    while (font.widthOfTextAtSize(remainder, size) > maxWidth && remainder.length > 1) {
      let cut = remainder.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(remainder.slice(0, cut), size) > maxWidth) cut--;
      lines.push(remainder.slice(0, cut));
      remainder = remainder.slice(cut);
    }
    current = remainder;
  }
  if (current) lines.push(current);
  return lines;
}

/* -------------------------------------------------------------- rendering */

interface Fonts {
  text: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
  monoBold: PDFFont;
}

interface Canvas {
  doc: PDFDocument;
  page: PDFPage;
  fonts: Fonts;
  y: number;
}

function drawText(
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
function drawRight(
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

function drawRule(page: PDFPage, y: number, from = MARGIN, to = RIGHT, thickness = 0.5): void {
  page.drawLine({ start: { x: from, y }, end: { x: to, y }, thickness, color: RULE });
}

function colRight(key: ColKey): number {
  return COL_X[key] + COLS[key] - 3;
}

function drawTableHead(canvas: Canvas): void {
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

function newPage(canvas: Canvas, data: InvoicePdfData): void {
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

function titleFor(documentType: InvoicePdfData["documentType"]): string {
  return documentType === "CREDIT_NOTE" ? "CREDIT NOTE" : "TAX INVOICE";
}

/* ----------------------------------------------------------------- header */

function drawPartyBlock(
  canvas: Canvas,
  heading: string,
  party: InvoicePdfParty,
  x: number,
  width: number,
): number {
  const { page, fonts } = canvas;
  let y = canvas.y;

  drawText(page, heading, x, y, fonts.bold, SMALL, GREY);
  y -= 11;
  for (const line of wrap(party.legalName || party.name, fonts.bold, BODY + 0.5, width)) {
    drawText(page, line, x, y, fonts.bold, BODY + 0.5);
    y -= 10;
  }
  if (party.legalName && party.legalName !== party.name) {
    for (const line of wrap(`(${party.name})`, fonts.text, SMALL, width)) {
      drawText(page, line, x, y, fonts.text, SMALL, GREY);
      y -= 9;
    }
  }
  for (const addressLine of party.addressLines) {
    if (!addressLine) continue;
    for (const line of wrap(addressLine, fonts.text, SMALL, width)) {
      drawText(page, line, x, y, fonts.text, SMALL);
      y -= 9;
    }
  }
  if (party.stateCode) {
    drawText(page, `State code: ${party.stateCode}`, x, y, fonts.text, SMALL);
    y -= 9;
  }
  const label = party.taxRegistrationLabel || "Tax reg. no.";
  drawText(page, `${label}: `, x, y, fonts.text, SMALL);
  drawText(
    page,
    party.taxRegistrationNumber ?? "Unregistered",
    x + fonts.text.widthOfTextAtSize(`${label}: `, SMALL),
    y,
    party.taxRegistrationNumber ? fonts.monoBold : fonts.text,
    SMALL,
  );
  y -= 9;
  if (party.email) {
    drawText(page, party.email, x, y, fonts.text, SMALL, GREY);
    y -= 9;
  }
  if (party.phone) {
    drawText(page, party.phone, x, y, fonts.text, SMALL, GREY);
    y -= 9;
  }
  return y;
}

function drawMetaBlock(canvas: Canvas, data: InvoicePdfData, x: number, width: number): number {
  const { page, fonts } = canvas;
  let y = canvas.y;

  drawText(page, "DOCUMENT", x, y, fonts.bold, SMALL, GREY);
  y -= 11;

  const rows: Array<[string, string]> = [
    ["Document type", data.documentType === "CREDIT_NOTE" ? "Credit note" : "Tax invoice"],
    ["Number", data.documentNumber],
    ["Date", data.documentDate],
  ];
  if (data.dueDate) rows.push(["Due date", data.dueDate]);
  rows.push(["Currency", data.currency]);
  rows.push(["Place of supply", data.placeOfSupply ?? "Not stated"]);
  rows.push(["Reverse charge", data.reverseCharge ? "Yes" : "No"]);
  if (data.supplyNature) rows.push(["Supply type", data.supplyNature]);
  if (data.originalDocumentNumber) {
    rows.push([
      "Against invoice",
      data.originalDocumentDate
        ? `${data.originalDocumentNumber} (${data.originalDocumentDate})`
        : data.originalDocumentNumber,
    ]);
  }
  if (data.reference) rows.push(["Reference", data.reference]);

  for (const [label, value] of rows) {
    drawText(page, label, x, y, fonts.text, SMALL, GREY);
    drawRight(page, value, x + width, y, fonts.mono, SMALL);
    y -= 10;
  }
  return y;
}

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

  for (const line of data.lines) {
    const descriptionLines = wrap(line.description, fonts.text, BODY, COLS.description - 6);
    const componentText = line.taxComponents
      .map((c) => `${c.component} ${formatRate(c.rateBp)} ${amount(c.taxMinor)}`)
      .join("   ");
    const componentLines = componentText
      ? wrap(componentText, fonts.mono, SMALL - 0.5, CONTENT_W - COLS.no - 6)
      : [];
    const needed = Math.max(descriptionLines.length, 1) * 10 + componentLines.length * 9 + 6;
    if (canvas.y - needed < BODY_FLOOR) newPage(canvas, data);

    const top = canvas.y;
    const page = canvas.page;

    drawText(page, String(line.lineNo), COL_X.no + 2, top, fonts.mono, SMALL);
    let descY = top;
    for (const text of descriptionLines) {
      drawText(page, text, COL_X.description + 2, descY, fonts.text, BODY);
      descY -= 10;
    }
    if (line.discountMinor > 0) {
      drawText(
        page,
        `Less discount ${formatMinor(line.discountMinor, data.currency)}`,
        COL_X.description + 2,
        descY,
        fonts.text,
        SMALL,
        GREY,
      );
      descY -= 9;
    }

    drawText(page, line.commodityCode ?? "-", COL_X.hsn + 2, top, fonts.mono, SMALL);
    drawRight(
      page,
      `${formatQuantity(line.quantityMilli)}${line.unit ? ` ${line.unit}` : ""}`,
      colRight("qty"),
      top,
      fonts.mono,
      SMALL,
    );
    drawRight(
      page,
      formatMinor(line.unitPriceMinor, data.currency),
      colRight("rate"),
      top,
      fonts.mono,
      SMALL,
    );
    drawRight(page, amount(line.taxableMinor), colRight("taxable"), top, fonts.mono, SMALL);
    drawRight(
      page,
      formatRate(line.taxComponents.reduce((total, c) => total + c.rateBp, 0)),
      colRight("taxPct"),
      top,
      fonts.mono,
      SMALL,
    );
    drawRight(page, amount(line.taxMinor), colRight("tax"), top, fonts.mono, SMALL);
    drawRight(page, amount(line.grossMinor), colRight("amount"), top, fonts.monoBold, SMALL);

    let bottom = Math.min(descY, top - 10);
    for (const text of componentLines) {
      drawText(page, text, COL_X.description + 2, bottom, fonts.mono, SMALL - 0.5, GREY);
      bottom -= 9;
    }

    canvas.y = bottom - 3;
    drawRule(canvas.page, canvas.y + 2, MARGIN, RIGHT, 0.25);
    canvas.y -= 5;
  }

  /* -- tax summary and totals -------------------------------------------- */
  const summaryHeight = 34 + data.taxSummary.length * 10 + 60;
  if (canvas.y - summaryHeight < BODY_FLOOR) newPage(canvas, data);

  canvas.y -= 6;
  const page = canvas.page;

  // Left: the tax split, one row per component and rate — GSTR-1 table 12 in
  // human form. Right: the money that ties to the ledger.
  const summaryTop = canvas.y;
  drawText(page, "TAX SUMMARY", MARGIN, summaryTop, fonts.bold, SMALL, GREY);
  let summaryY = summaryTop - 12;
  const summaryRight = MARGIN + 270;
  drawText(page, "Component", MARGIN, summaryY, fonts.bold, SMALL);
  drawRight(page, "Rate", MARGIN + 150, summaryY, fonts.bold, SMALL);
  drawRight(page, "Taxable", MARGIN + 215, summaryY, fonts.bold, SMALL);
  drawRight(page, "Tax", summaryRight, summaryY, fonts.bold, SMALL);
  summaryY -= 4;
  drawRule(page, summaryY, MARGIN, summaryRight);
  summaryY -= 10;

  if (data.taxSummary.length === 0) {
    drawText(page, "No tax on this document", MARGIN, summaryY, fonts.text, SMALL, GREY);
    summaryY -= 10;
  }
  for (const component of data.taxSummary) {
    drawText(page, component.component, MARGIN, summaryY, fonts.mono, SMALL);
    drawRight(page, formatRate(component.rateBp), MARGIN + 150, summaryY, fonts.mono, SMALL);
    drawRight(page, amount(component.taxableMinor), MARGIN + 215, summaryY, fonts.mono, SMALL);
    drawRight(page, amount(component.taxMinor), summaryRight, summaryY, fonts.mono, SMALL);
    summaryY -= 10;
  }

  let totalsY = summaryTop;
  const totalsLabelX = MARGIN + 300;
  const totalRows: Array<[string, string, boolean]> = [
    ["Taxable value", amount(data.netMinor), false],
    ...data.taxSummary.map(
      (c) =>
        [`${c.component} ${formatRate(c.rateBp)}`, amount(c.taxMinor), false] as [
          string,
          string,
          boolean,
        ],
    ),
    ["Total tax", amount(data.taxMinor), false],
  ];
  if (data.roundingMinor !== 0) {
    totalRows.push(["Rounding", amount(data.roundingMinor), false]);
  }
  totalRows.push([
    data.documentType === "CREDIT_NOTE" ? "Total credit" : "Total payable",
    amount(data.grossMinor),
    true,
  ]);

  for (const [label, value, strong] of totalRows) {
    if (strong) {
      // The banded total is taller than a plain row, so give it its own gap
      // rather than letting the band paint over the line above it.
      totalsY -= 5;
      page.drawRectangle({
        x: totalsLabelX - 6,
        y: totalsY - 4,
        width: RIGHT - totalsLabelX + 6,
        height: 14,
        color: BAND,
      });
      drawText(page, label, totalsLabelX, totalsY, fonts.bold, BODY + 1);
      drawRight(page, `${data.currency} ${value}`, RIGHT - 4, totalsY, fonts.monoBold, BODY + 1);
    } else {
      drawText(page, label, totalsLabelX, totalsY, fonts.text, SMALL);
      drawRight(page, value, RIGHT - 4, totalsY, fonts.mono, SMALL);
    }
    totalsY -= strong ? 18 : 10;
  }

  canvas.y = Math.min(summaryY, totalsY) - 8;

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
