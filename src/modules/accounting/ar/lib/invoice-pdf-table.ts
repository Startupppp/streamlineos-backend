/**
 * The body of the tax-invoice PDF: one row per line, then the tax summary and
 * the totals that tie to the ledger. Both draw from `canvas.y` down and roll
 * onto a new page rather than past `BODY_FLOOR`.
 */
import {
  BAND,
  BODY,
  BODY_FLOOR,
  COLS,
  COL_X,
  CONTENT_W,
  GREY,
  MARGIN,
  RIGHT,
  SMALL,
  colRight,
  drawRight,
  drawRule,
  drawText,
  newPage,
  type Canvas,
} from "./invoice-pdf-canvas";
import { formatMinor, formatQuantity, formatRate, wrap } from "./invoice-pdf-format";
import type { InvoicePdfData } from "./invoice-pdf.types";

/** Minor units to the printed figure, already signed for the document type. */
export type FormatAmount = (minor: number) => string;

/* -- lines ------------------------------------------------------------- */

export function drawLineRows(canvas: Canvas, data: InvoicePdfData, amount: FormatAmount): void {
  const { fonts } = canvas;

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
}

/* -- tax summary and totals -------------------------------------------- */

export function drawTaxSummaryAndTotals(
  canvas: Canvas,
  data: InvoicePdfData,
  amount: FormatAmount,
): void {
  const { fonts } = canvas;
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
}
