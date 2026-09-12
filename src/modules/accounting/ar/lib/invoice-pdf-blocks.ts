/**
 * The header blocks of the tax-invoice PDF: a party (supplier or bill-to) and
 * the document's own facts. Each draws down from `canvas.y` and returns where
 * it stopped, so the caller can lay two side by side.
 */
import { BODY, GREY, SMALL, drawRight, drawText, type Canvas } from "./invoice-pdf-canvas";
import { wrap } from "./invoice-pdf-format";
import type { InvoicePdfData, InvoicePdfParty } from "./invoice-pdf.types";

/* ----------------------------------------------------------------- header */

export function drawPartyBlock(
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

export function drawMetaBlock(
  canvas: Canvas,
  data: InvoicePdfData,
  x: number,
  width: number,
): number {
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
