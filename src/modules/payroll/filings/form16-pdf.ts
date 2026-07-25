/**
 * Form 16 period-summary PDF (pilot).
 * NOT an official Income-tax Form 16 Part A/B certificate.
 * For external preparation support only.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export interface Form16CertificateInput {
  employerName: string;
  employeeName: string;
  employeeNumber: string | null;
  pan: string | null;
  email: string | null;
  fiscalYear: string | null;
  periodMonth: string | null;
  periodGross: string;
  periodTds: string;
  periodNet: string;
  ruleBundleVersion: string;
  formLabel: string;
}

const NAVY = rgb(0.059, 0.169, 0.498);
const BLACK = rgb(0.1, 0.1, 0.1);
const GRAY = rgb(0.4, 0.4, 0.4);
const AMBER = rgb(0.72, 0.45, 0.05);
const LIGHT = rgb(0.97, 0.95, 0.9);

function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  color = BLACK,
): void {
  page.drawText(text.replace(/[^\x20-\x7E]/g, "?"), { x, y, size, font, color });
}

export async function generateForm16SummaryPdf(data: Form16CertificateInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const { height, width } = page.getSize();
  const margin = 48;
  let y = height - margin;

  // Header
  page.drawRectangle({ x: 0, y: y - 56, width, height: 56, color: NAVY });
  drawText(page, data.formLabel + " — Period Summary", margin, y - 28, bold, 14, rgb(1, 1, 1));
  drawText(page, "NOT an official Form 16 certificate", margin, y - 44, regular, 9, rgb(1, 0.9, 0.7));
  y -= 80;

  // Honesty banner
  page.drawRectangle({
    x: margin,
    y: y - 48,
    width: width - margin * 2,
    height: 48,
    color: LIGHT,
  });
  drawText(
    page,
    "Pilot export for external preparation only. StreamlineOS does not issue legally binding",
    margin + 8,
    y - 18,
    regular,
    9,
    AMBER,
  );
  drawText(
    page,
    "Form 16 Part A/B. Submit official certificates via the Income Tax portal / TRACES.",
    margin + 8,
    y - 32,
    regular,
    9,
    AMBER,
  );
  y -= 72;

  drawText(page, "Employer", margin, y, bold, 10, GRAY);
  y -= 16;
  drawText(page, data.employerName || "—", margin, y, regular, 11);
  y -= 28;

  drawText(page, "Employee", margin, y, bold, 10, GRAY);
  y -= 16;
  drawText(page, data.employeeName || "—", margin, y, regular, 11);
  y -= 14;
  drawText(
    page,
    `Emp No: ${data.employeeNumber ?? "—"}  |  PAN: ${data.pan ?? "—"}  |  ${data.email ?? ""}`,
    margin,
    y,
    regular,
    9,
    GRAY,
  );
  y -= 32;

  drawText(page, "Period", margin, y, bold, 10, GRAY);
  y -= 16;
  drawText(
    page,
    `FY: ${data.fiscalYear ?? "—"}  |  Month: ${data.periodMonth ?? "—"}  |  Rule: ${data.ruleBundleVersion}`,
    margin,
    y,
    regular,
    10,
  );
  y -= 36;

  // Amounts table
  const rows: Array<[string, string]> = [
    ["Period gross (from payroll run)", data.periodGross],
    ["Period TDS deducted (line codes)", data.periodTds],
    ["Period net", data.periodNet],
  ];
  for (const [label, value] of rows) {
    page.drawRectangle({
      x: margin,
      y: y - 22,
      width: width - margin * 2,
      height: 26,
      color: rgb(0.96, 0.97, 0.99),
    });
    drawText(page, label, margin + 10, y - 14, regular, 10);
    drawText(page, value, width - margin - 100, y - 14, bold, 10);
    y -= 32;
  }

  y -= 24;
  drawText(
    page,
    "This document is generated from payroll engine period figures for internal/export use.",
    margin,
    y,
    regular,
    8,
    GRAY,
  );
  y -= 12;
  drawText(
    page,
    "It is not a substitute for Form 16 issued under the Income-tax Act.",
    margin,
    y,
    regular,
    8,
    GRAY,
  );

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
