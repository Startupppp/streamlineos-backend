import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

export interface PayslipPdfData {
  orgName: string;
  orgAddress?: string;
  currencyCode?: string;
  currencyLocale?: string;
  employeeName: string;
  employeeId?: string;
  designation?: string;
  department?: string;
  panNumber?: string;
  pfUan?: string;
  bankName?: string;
  maskedAccount?: string;
  ifsc?: string;
  joiningDate?: string;
  monthLabel: string;
  workingDays?: number;
  basicSalary: number;
  hra: number;
  allowances: number;
  overtimeAmount: number;
  grossSalary: number;
  deductions: number;
  professionalTax?: number;
  netSalary: number;
}

const NAVY = rgb(0.059, 0.169, 0.498);
const GOLD = rgb(0.741, 0.533, 0.173);
const WHITE = rgb(1, 1, 1);
const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.4, 0.4, 0.4);
const LIGHT_GRAY = rgb(0.94, 0.95, 0.98);
const GREEN = rgb(0.086, 0.502, 0.243);
const RED = rgb(0.7, 0.1, 0.1);

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatGeneratedAt(d: Date): string {
  return `${pad2(d.getDate())} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()} at ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function toWords(n: number): string {
  const a = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen",
  ];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function helper(num: number): string {
    if (num < 20) return a[num] ?? "";
    if (num < 100) return (b[Math.floor(num / 10)] ?? "") + (num % 10 ? " " + (a[num % 10] ?? "") : "");
    if (num < 1000) return (a[Math.floor(num / 100)] ?? "") + " Hundred" + (num % 100 ? " " + helper(num % 100) : "");
    if (num < 100000) return helper(Math.floor(num / 1000)) + " Thousand" + (num % 1000 ? " " + helper(num % 1000) : "");
    if (num < 10000000) return helper(Math.floor(num / 100000)) + " Lakh" + (num % 100000 ? " " + helper(num % 100000) : "");
    return helper(Math.floor(num / 10000000)) + " Crore" + (num % 10000000 ? " " + helper(num % 10000000) : "");
  }

  if (n === 0) return "Zero Rupees Only";
  return helper(Math.floor(n)) + " Rupees Only";
}


function drawRect(page: PDFPage, x: number, y: number, w: number, h: number, color: ReturnType<typeof rgb>): void {
  page.drawRectangle({ x, y, width: w, height: h, color });
}

function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  color: ReturnType<typeof rgb> = BLACK,
): void {
  page.drawText(text, { x, y, size, font, color });
}

function drawLine(page: PDFPage, x1: number, y1: number, x2: number, y2: number): void {
  page.drawLine({
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    thickness: 0.5,
    color: rgb(0.85, 0.85, 0.85),
  });
}

export async function generatePayslipPdf(data: PayslipPdfData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);

  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  const currencySymbol = data.currencyCode === "INR" || !data.currencyCode ? "Rs" : (data.currencyCode ?? "Rs");
  const currencyLocale = data.currencyLocale ?? "en-IN";
  const fmt = (v: number) =>
    currencySymbol + " " + v.toLocaleString(currencyLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const { height } = page.getSize();
  const margin = 40;
  const pageW = 595;
  const contentW = pageW - margin * 2;

  let y = height - margin;

  drawRect(page, 0, y - 70, pageW, 70, NAVY);

  drawRect(page, margin, y - 62, 52, 52, GOLD);
  drawText(page, "V", margin + 14, y - 42, bold, 28, WHITE);

  const companyFullName = data.orgName;
  drawText(page, companyFullName, margin + 56, y - 20, bold, 14, WHITE);
  if (data.orgAddress) {
    drawText(page, data.orgAddress, margin + 56, y - 34, regular, 8, rgb(0.8, 0.85, 1));
  }

  const slipLabel = "Salary Slip";
  const slipW = bold.widthOfTextAtSize(slipLabel, 14);
  drawText(page, slipLabel, pageW - margin - slipW, y - 20, bold, 14, WHITE);
  const monthW = regular.widthOfTextAtSize(data.monthLabel, 9);
  drawText(page, `For: ${data.monthLabel}`, pageW - margin - monthW - 20, y - 34, regular, 9, rgb(0.8, 0.85, 1));

  y -= 70;

  drawRect(page, 0, y - 32, pageW, 32, NAVY);
  const empFields: [string, string][] = [
    ["Employee", data.employeeName],
    ["ID", data.employeeId ?? "—"],
    ["Designation", data.designation ?? "—"],
    ["Department", data.department ?? "—"],
  ];
  let xOff = margin;
  for (const [label, value] of empFields) {
    drawText(page, label.toUpperCase(), xOff, y - 12, regular, 7, rgb(0.7, 0.75, 0.9));
    drawText(page, value, xOff, y - 24, bold, 9, WHITE);
    xOff += contentW / empFields.length;
  }
  y -= 32;

  drawRect(page, margin, y - 22, 44, 16, GREEN);
  drawText(page, "PAID", margin + 8, y - 17, bold, 9, WHITE);
  y -= 28;

  drawLine(page, margin, y, pageW - margin, y);
  y -= 10;

  const col1X = margin;
  const col2X = margin + contentW / 2 + 10;
  const colW = contentW / 2 - 10;
  let rowY = y;

  function drawSectionHeader(px: number, py: number, title: string): number {
    drawText(page, title, px, py, bold, 8, NAVY);
    drawLine(page, px, py - 4, px + colW, py - 4);
    return py - 16;
  }

  function drawRow(px: number, py: number, key: string, val: string): number {
    drawText(page, key, px, py, regular, 8, GRAY);
    const valW = regular.widthOfTextAtSize(val, 8);
    drawText(page, val, px + colW - valW, py, regular, 8, BLACK);
    return py - 14;
  }

  rowY = drawSectionHeader(col1X, rowY, "EMPLOYEE INFORMATION");
  rowY = drawRow(col1X, rowY, "Date of Joining", data.joiningDate ?? "—");
  rowY = drawRow(col1X, rowY, "PAN Number", data.panNumber ?? "—");
  if (data.pfUan) {
    rowY = drawRow(col1X, rowY, "PF UAN", data.pfUan);
  }

  let rowY2 = y;
  rowY2 = drawSectionHeader(col2X, rowY2, "PAYROLL INFORMATION");
  rowY2 = drawRow(col2X, rowY2, "Pay Period", data.monthLabel);
  rowY2 = drawRow(col2X, rowY2, "Payment Mode", "Bank Transfer");
  rowY2 = drawRow(col2X, rowY2, "Working Days", String(data.workingDays ?? 30));

  y = Math.min(rowY, rowY2) - 10;
  drawLine(page, margin, y, pageW - margin, y);
  y -= 14;

  drawText(page, "SALARY BREAKDOWN", margin, y, bold, 8, NAVY);
  drawLine(page, margin, y - 4, pageW - margin, y - 4);
  y -= 18;

  const earningsW = contentW * 0.35;
  const amtW = contentW * 0.15;

  drawRect(page, margin, y - 4, contentW, 16, LIGHT_GRAY);
  drawText(page, "Earnings", margin + 4, y + 4, bold, 8, NAVY);
  drawText(page, "Amount", margin + earningsW + amtW - 4, y + 4, bold, 8, NAVY);
  drawText(page, "Deductions", margin + earningsW + amtW + 4, y + 4, bold, 8, NAVY);
  drawText(page, "Amount", margin + contentW - 4, y + 4, bold, 8, NAVY);
  y -= 18;

  const earningsRows: [string, number][] = [
    ["Basic Salary", data.basicSalary],
    ...(data.hra > 0 ? [["HRA", data.hra] as [string, number]] : []),
    ...(data.allowances > 0 ? [["Special Allowance", data.allowances] as [string, number]] : []),
    ...(data.overtimeAmount > 0 ? [["Overtime", data.overtimeAmount] as [string, number]] : []),
  ];

  const professionalTax = data.professionalTax ?? 200;
  const otherDeductions = data.deductions - professionalTax;
  const deductionRows: [string, number][] = [];
  if (professionalTax > 0) {
    deductionRows.push(["Professional Tax", professionalTax]);
  }
  if (otherDeductions > 0) {
    deductionRows.push(["Other Deductions", otherDeductions]);
  }
  if (deductionRows.length === 0 && data.deductions > 0) {
    deductionRows.push(["Total Deductions", data.deductions]);
  }

  const maxRows = Math.max(earningsRows.length, deductionRows.length);

  for (let i = 0; i < maxRows; i++) {
    const earning = earningsRows[i];
    if (earning) {
      const [label, amount] = earning;
      drawText(page, label, margin + 4, y, regular, 8);
      if (amount > 0) {
        const aw = regular.widthOfTextAtSize(fmt(amount), 8);
        drawText(page, fmt(amount), margin + earningsW + amtW - 4 - aw, y, regular, 8);
      }
    }
    const deduction = deductionRows[i];
    if (deduction) {
      const [label, amount] = deduction;
      drawText(page, label, margin + earningsW + amtW + 4, y, regular, 8);
      const dw = regular.widthOfTextAtSize(fmt(amount), 8);
      drawText(page, fmt(amount), margin + contentW - 4 - dw, y, regular, 8, RED);
    }
    y -= 14;
  }

  drawRect(page, margin, y - 4, contentW, 16, LIGHT_GRAY);
  drawText(page, "Gross Earnings", margin + 4, y + 4, bold, 8, NAVY);
  const gw = bold.widthOfTextAtSize(fmt(data.grossSalary), 8);
  drawText(page, fmt(data.grossSalary), margin + earningsW + amtW - 4 - gw, y + 4, bold, 8, NAVY);
  drawText(page, "Net Deductions", margin + earningsW + amtW + 4, y + 4, bold, 8, NAVY);
  const ndw = bold.widthOfTextAtSize(fmt(data.deductions), 8);
  drawText(page, fmt(data.deductions), margin + contentW - 4 - ndw, y + 4, bold, 8, RED);
  y -= 24;

  drawRect(page, 0, y - 28, pageW, 28, NAVY);
  drawText(page, "NET SALARY PAYABLE", margin, y - 18, bold, 10, WHITE);
  const netStr = fmt(data.netSalary);
  const nw = bold.widthOfTextAtSize(netStr, 14);
  drawText(page, netStr, pageW - margin - nw, y - 20, bold, 14, GOLD);
  y -= 28;

  drawRect(page, 0, y - 18, pageW, 18, LIGHT_GRAY);
  drawText(page, `In words: ${toWords(data.netSalary)}`, margin, y - 12, oblique, 8, GRAY);
  y -= 22;

  drawLine(page, margin, y, pageW - margin, y);
  y -= 14;

  let bankY = y;
  bankY = drawSectionHeader(col1X, bankY, "BANK DETAILS");
  bankY = drawRow(col1X, bankY, "Bank Name", data.bankName ?? "—");
  bankY = drawRow(col1X, bankY, "Account Number", data.maskedAccount ?? "—");
  bankY = drawRow(col1X, bankY, "IFSC Code", data.ifsc ?? "—");

  let authY = y;
  authY = drawSectionHeader(col2X, authY, "AUTHORISATION");
  authY -= 2;
  drawText(page, "This is a system-generated payslip and does", col2X, authY, regular, 7.5, GRAY);
  authY -= 12;
  drawText(page, "not require a physical signature.", col2X, authY, regular, 7.5, GRAY);
  authY -= 20;
  drawLine(page, col2X, authY, col2X + colW, authY);
  drawText(page, "Authorised Signatory", col2X + colW / 2 - 35, authY - 10, regular, 8, GRAY);

  const footerText = `Generated ${formatGeneratedAt(new Date())}  ·  ${data.orgName}  ·  Confidential — For Employee Use Only`;
  const fw = regular.widthOfTextAtSize(footerText, 7.5);
  drawRect(page, 0, 0, pageW, 28, LIGHT_GRAY);
  drawText(page, footerText, pageW / 2 - fw / 2, 10, regular, 7.5, GRAY);

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
