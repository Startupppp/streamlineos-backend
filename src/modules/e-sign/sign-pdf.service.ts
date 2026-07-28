import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont } from "pdf-lib";

export interface StampField {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldType: string;
  textValue?: string | null;
  checked?: boolean;
  imageBytes?: Buffer;
  imageFormat?: "png" | "jpg";
  fontStyle?: "normal" | "signature";
}

export interface CertificateData {
  certificateNumber: string;
  tenantName: string;
  envelopeTitle: string;
  senderName: string;
  senderEmail: string;
  finalPdfHash: string;
  watermarked: boolean;
  completedAt: string;
  documents: { fileName: string; sha256Hash: string; pageCount: number | null }[];
  recipients: { name: string; email: string | null; role: string; authMethod: string; completedAt: string | null }[];
  events: { eventType: string; actorName: string | null; createdAt: string; ipAddress: string | null }[];
}

export interface WatermarkSpec {
  text?: string | null;
  imageBytes?: Buffer | null;
  opacity: number;
  angle: number;
  color: string;
  fontSize: number;
  pages: { mode: "all" | "first" | "custom"; pageNumbers?: number[] };
}

function hexToRgbFraction(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const int = Number.parseInt(full, 16);
  if (Number.isNaN(int)) return { r: 0.6, g: 0.6, b: 0.6 };
  return { r: ((int >> 16) & 255) / 255, g: ((int >> 8) & 255) / 255, b: (int & 255) / 255 };
}

function resolvePageIndexes(pages: WatermarkSpec["pages"], totalPages: number): number[] {
  if (pages.mode === "first") return totalPages > 0 ? [0] : [];
  if (pages.mode === "custom") {
    return (pages.pageNumbers ?? [])
      .map((n) => n - 1)
      .filter((idx) => idx >= 0 && idx < totalPages);
  }
  return Array.from({ length: totalPages }, (_, i) => i);
}

@Injectable()
export class SignPdfService {
  computeSha256(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
  }

  async getPageCount(buffer: Buffer): Promise<number> {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount();
  }

  async getPageDimensions(buffer: Buffer, pageNumber: number): Promise<{ width: number; height: number }> {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const page = doc.getPage(pageNumber - 1);
    return page.getSize();
  }

  async mergeDocuments(buffers: Buffer[]): Promise<Buffer> {
    const merged = await PDFDocument.create();
    for (const buf of buffers) {
      const src = await PDFDocument.load(buf, { ignoreEncryption: true });
      const copied = await merged.copyPages(src, src.getPageIndices());
      copied.forEach((p) => merged.addPage(p));
    }
    return Buffer.from(await merged.save());
  }

  /**
   * Draws completed field values directly onto page content (signatures, initials, stamps as
   * images; text/date/dropdown/radio as text; checkboxes as a checkmark). Because these are
   * drawn as static page content rather than interactive AcroForm fields, the result is already
   * flattened — there is nothing left for a signer or viewer to edit afterward.
   */
  async stampFields(pdfBytes: Buffer, fields: StampField[]): Promise<Buffer> {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const signatureFont = await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique);
    const pages = pdfDoc.getPages();

    for (const field of fields) {
      const page = pages[field.pageNumber - 1];
      if (!page) continue;
      const { height: pageHeight } = page.getSize();
      const pdfY = pageHeight - field.y - field.height;

      if (field.imageBytes) {
        const image =
          field.imageFormat === "jpg"
            ? await pdfDoc.embedJpg(field.imageBytes)
            : await pdfDoc.embedPng(field.imageBytes);
        page.drawImage(image, { x: field.x, y: pdfY, width: field.width, height: field.height });
        continue;
      }

      if (field.fieldType === "checkbox") {
        if (field.checked) {
          const size = Math.min(field.height - 4, 14);
          page.drawText("X", { x: field.x + 2, y: pdfY + 2, size, font, color: rgb(0, 0, 0) });
        }
        continue;
      }

      if (field.textValue) {
        const useFont = field.fontStyle === "signature" ? signatureFont : font;
        this.drawFittedText(page, useFont, field.textValue, field.x, pdfY, field.width, field.height);
      }
    }

    return Buffer.from(await pdfDoc.save());
  }

  private drawFittedText(
    page: ReturnType<PDFDocument["getPage"]>,
    font: PDFFont,
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const maxSize = Math.max(6, Math.min(height * 0.65, 12));
    let size = maxSize;
    while (size > 6 && font.widthOfTextAtSize(text, size) > width - 4) size -= 1;
    page.drawText(text, {
      x: x + 2,
      y: y + Math.max(2, (height - size) / 2),
      size,
      font,
      color: rgb(0, 0, 0),
      maxWidth: Math.max(1, width - 4),
    });
  }

  async applyWatermark(pdfBytes: Buffer, spec: WatermarkSpec): Promise<Buffer> {
    if (!spec.text && !spec.imageBytes) return pdfBytes;
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const pages = pdfDoc.getPages();
    const targetIndexes = resolvePageIndexes(spec.pages, pages.length);
    const color = hexToRgbFraction(spec.color);
    const opacity = Math.min(Math.max(spec.opacity, 0), 100) / 100;

    let font: PDFFont | undefined;
    let image: Awaited<ReturnType<PDFDocument["embedPng"]>> | undefined;
    if (spec.text) font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    if (spec.imageBytes) image = await pdfDoc.embedPng(spec.imageBytes);

    for (const idx of targetIndexes) {
      const page = pages[idx];
      const { width, height } = page.getSize();

      if (image) {
        const imgDims = image.scale(0.5);
        page.drawImage(image, {
          x: (width - imgDims.width) / 2,
          y: (height - imgDims.height) / 2,
          width: imgDims.width,
          height: imgDims.height,
          opacity,
        });
        continue;
      }

      if (font && spec.text) {
        const textWidth = font.widthOfTextAtSize(spec.text, spec.fontSize);
        const stepX = textWidth + 100;
        const stepY = spec.fontSize + 100;
        for (let ty = -height; ty < height * 2; ty += stepY) {
          for (let tx = -width; tx < width * 2; tx += stepX) {
            page.drawText(spec.text, {
              x: tx,
              y: ty,
              size: spec.fontSize,
              font,
              color: rgb(color.r, color.g, color.b),
              opacity,
              rotate: degrees(spec.angle),
            });
          }
        }
      }
    }

    return Buffer.from(await pdfDoc.save());
  }

  async generateCertificatePdf(data: CertificateData): Promise<Buffer> {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let page = pdfDoc.addPage([612, 792]);
    let cursorY = 742;
    const marginX = 56;
    const lineHeight = 16;

    const ensureSpace = (needed: number) => {
      if (cursorY - needed < 56) {
        page = pdfDoc.addPage([612, 792]);
        cursorY = 742;
      }
    };

    const drawLine = (text: string, opts?: { bold?: boolean; size?: number; gap?: number }) => {
      const size = opts?.size ?? 10;
      ensureSpace(lineHeight);
      page.drawText(text, { x: marginX, y: cursorY, size, font: opts?.bold ? bold : font, color: rgb(0.1, 0.1, 0.1) });
      cursorY -= (opts?.gap ?? lineHeight);
    };

    drawLine("Certificate of Completion", { bold: true, size: 20, gap: 28 });
    drawLine(`Certificate Number: ${data.certificateNumber}`);
    drawLine(`Organization: ${data.tenantName}`);
    drawLine(`Envelope: ${data.envelopeTitle}`);
    drawLine(`Sender: ${data.senderName} <${data.senderEmail}>`);
    drawLine(`Completed at: ${data.completedAt}`);
    drawLine(`Final PDF SHA-256: ${data.finalPdfHash}`, { gap: 24 });
    drawLine(`Watermarked final PDF: ${data.watermarked ? "Yes" : "No"}`, { gap: 24 });

    drawLine("Documents", { bold: true, size: 13, gap: 20 });
    for (const doc of data.documents) {
      drawLine(`${doc.fileName} — ${doc.pageCount ?? "?"} page(s) — SHA-256: ${doc.sha256Hash}`);
    }
    cursorY -= 8;

    drawLine("Recipients", { bold: true, size: 13, gap: 20 });
    for (const r of data.recipients) {
      drawLine(`${r.name}${r.email ? ` <${r.email}>` : ""} — ${r.role} — auth: ${r.authMethod} — completed: ${r.completedAt ?? "n/a"}`);
    }
    cursorY -= 8;

    drawLine("Event Timeline", { bold: true, size: 13, gap: 20 });
    for (const event of data.events) {
      const actor = event.actorName ? ` by ${event.actorName}` : "";
      const ip = event.ipAddress ? ` from ${event.ipAddress}` : "";
      drawLine(`${event.createdAt} — ${event.eventType}${actor}${ip}`, { size: 9 });
    }

    return Buffer.from(await pdfDoc.save());
  }
}
