import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface OfferPlaceholderVars {
  candidateName: string;
  designation: string;
  salary: string;
  joiningDate: string;
  validUntil: string;
  orgName: string;
}

function applyPlaceholders(html: string, vars: OfferPlaceholderVars): string {
  return html
    .replace(/\{\{candidate_name\}\}/g, vars.candidateName)
    .replace(/\{\{designation\}\}/g, vars.designation)
    .replace(/\{\{salary\}\}/g, vars.salary)
    .replace(/\{\{joining_date\}\}/g, vars.joiningDate)
    .replace(/\{\{valid_until\}\}/g, vars.validUntil)
    .replace(/\{\{org_name\}\}/g, vars.orgName);
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li>/gi, "  • ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function renderOfferLetterPdf(
  htmlContent: string,
  vars: OfferPlaceholderVars,
): Promise<string> {
  const hydrated = applyPlaceholders(htmlContent, vars);
  const plainText = stripHtml(hydrated);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 60;
  const lineHeight = 18;
  const fontSize = 11;
  const maxWidth = pageWidth - margin * 2;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const lines = plainText.split("\n");

  for (const rawLine of lines) {
    const words = rawLine.split(" ");
    let current = "";

    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      const width = font.widthOfTextAtSize(test, fontSize);
      if (width > maxWidth && current) {
        if (y < margin + lineHeight) {
          page = pdfDoc.addPage([pageWidth, pageHeight]);
          y = pageHeight - margin;
        }
        page.drawText(current, { x: margin, y, size: fontSize, font, color: rgb(0, 0, 0) });
        y -= lineHeight;
        current = word;
      } else {
        current = test;
      }
    }

    if (current.trim()) {
      if (y < margin + lineHeight) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      page.drawText(current, { x: margin, y, size: fontSize, font, color: rgb(0, 0, 0) });
    }
    y -= lineHeight;
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes).toString("base64");
}
