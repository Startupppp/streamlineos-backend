import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatDayMonthYear, formatDayMonthYearTime } from "../../../common/date";

export interface ProfileEmployee {
  id: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
  role: string;
  designation: string | null;
  employeeId: string | null;
  joiningDate: string | Date | null;
  reportingTo: string | null;
  isActive: boolean;
  bio: string | null;
  linkedinUrl: string | null;
  phone: string | null;
}

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;
const NAVY = rgb(0.059, 0.169, 0.498);
const GOLD = rgb(0.741, 0.533, 0.173);
const BLACK = rgb(0.067, 0.067, 0.067);
const GRAY = rgb(0.45, 0.45, 0.45);
const RULE = rgb(0.898, 0.906, 0.922);

/** StandardFonts only support WinAnsi — strip unsupported glyphs. */
function pdfSafe(value: string | null | undefined, fallback = "-"): string {
  if (value == null || value.trim() === "") return fallback;
  return (
    value
      .replace(/\u20B9/g, "Rs ")
      .replace(/[^\x20-\x7E\n\r\t]/g, "?")
      .trim() || fallback
  );
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
  page.drawText(text, { x, y, size, font, color });
}

function wrapLines(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = "";
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
  }

  return lines;
}

type Field = { label: string; value: string };

function drawSectionTitle(
  page: PDFPage,
  title: string,
  y: number,
  bold: PDFFont,
  contentW: number,
): number {
  drawText(page, title.toUpperCase(), MARGIN, y, bold, 10, GOLD);
  page.drawLine({
    start: { x: MARGIN, y: y - 6 },
    end: { x: MARGIN + contentW, y: y - 6 },
    thickness: 0.75,
    color: RULE,
  });
  return y - 22;
}

function drawFieldGrid(
  page: PDFPage,
  fields: Field[],
  startY: number,
  regular: PDFFont,
  bold: PDFFont,
  contentW: number,
): number {
  const colW = contentW / 2;
  let y = startY;
  for (let i = 0; i < fields.length; i += 2) {
    const left = fields[i]!;
    const right = fields[i + 1];
    drawText(page, left.label, MARGIN, y, regular, 9, GRAY);
    drawText(page, pdfSafe(left.value), MARGIN, y - 14, bold, 11, BLACK);
    if (right) {
      drawText(page, right.label, MARGIN + colW, y, regular, 9, GRAY);
      drawText(page, pdfSafe(right.value), MARGIN + colW, y - 14, bold, 11, BLACK);
    }
    y -= 36;
  }
  return y;
}

export async function buildEmployeeProfilePdf(
  employee: ProfileEmployee,
  skills: { name: string; level: number }[],
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  const contentW = PAGE_W - MARGIN * 2;
  let y = PAGE_H - MARGIN;

  const name = pdfSafe(
    employee.name ??
      (`${employee.firstName ?? ""} ${employee.lastName ?? ""}`.trim() || null),
    "Employee",
  );
  const joinDate = employee.joiningDate
    ? formatDayMonthYear(new Date(employee.joiningDate))
    : "-";
  const ensureSpace = (needed: number) => {
    if (y < MARGIN + needed) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  drawText(page, name, MARGIN, y, bold, 20, NAVY);
  y -= 18;
  const subtitle = pdfSafe(
    `${employee.designation ?? "-"} | ${employee.email ?? "-"}`,
  );
  drawText(page, subtitle, MARGIN, y, regular, 11, GRAY);
  y -= 28;

  y = drawSectionTitle(page, "Personal Information", y, bold, contentW);
  y = drawFieldGrid(
    page,
    [
      { label: "Employee ID", value: employee.employeeId ?? employee.id },
      { label: "Email", value: employee.email },
      { label: "Phone", value: employee.phone ?? "-" },
      { label: "LinkedIn", value: employee.linkedinUrl ?? "-" },
    ],
    y,
    regular,
    bold,
    contentW,
  );
  y -= 8;

  ensureSpace(160);
  y = drawSectionTitle(page, "Employment Details", y, bold, contentW);
  y = drawFieldGrid(
    page,
    [
      { label: "Role", value: employee.role ?? "-" },
      { label: "Designation", value: employee.designation ?? "-" },
      { label: "Joining Date", value: joinDate },
      { label: "Status", value: employee.isActive ? "Active" : "Inactive" },
      { label: "Reports To", value: employee.reportingTo ?? "-" },
    ],
    y,
    regular,
    bold,
    contentW,
  );
  y -= 8;

  if (employee.bio?.trim()) {
    ensureSpace(80);
    y = drawSectionTitle(page, "Bio", y, bold, contentW);
    const bioLines = wrapLines(pdfSafe(employee.bio), regular, 11, contentW);
    for (const line of bioLines) {
      ensureSpace(16);
      if (line) drawText(page, line, MARGIN, y, regular, 11, BLACK);
      y -= 14;
    }
    y -= 10;
  }

  ensureSpace(60);
  y = drawSectionTitle(page, "Skills", y, bold, contentW);
  const skillsText =
    skills.length > 0 ? skills.map((s) => pdfSafe(s.name)).join(", ") : "-";
  const skillLines = wrapLines(skillsText, regular, 11, contentW);
  for (const line of skillLines) {
    ensureSpace(16);
    if (line) drawText(page, line, MARGIN, y, regular, 11, BLACK);
    y -= 14;
  }

  ensureSpace(40);
  y -= 12;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: MARGIN + contentW, y },
    thickness: 0.75,
    color: RULE,
  });
  y -= 16;
  drawText(
    page,
    pdfSafe(
      `Generated on ${formatDayMonthYearTime(new Date())} - Confidential HR Record`,
    ),
    MARGIN,
    y,
    regular,
    9,
    GRAY,
  );

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
