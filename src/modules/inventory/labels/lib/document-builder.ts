import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.82, 0.84, 0.87);
const BAND = rgb(0.95, 0.96, 0.97);

export interface DocumentColumn {
  readonly header: string;
  /** A share of the content width; the shares are normalised, not absolute. */
  readonly weight: number;
  readonly align?: "left" | "right";
}

/**
 * G4 — a warehouse document, in the only PDF library this repository already
 * has.
 *
 * `pdf-lib` draws text at coordinates and nothing else: it has no concept of a
 * line, a table, a page break or a footer. Every existing PDF in this codebase
 * therefore reimplements wrapping and paging inline — the offer letter, the
 * payslip, the Form 16 — and each got a slightly different answer, which is fine
 * while they are one document apiece and stops being fine the moment two
 * documents in the same module have to look like each other.
 *
 * So the paging rules live here once. The ones that matter:
 *
 *   **A table header repeats on every page.** A pick list that runs to three
 *   pages is read one page at a time, on a trolley, and a column of bare numbers
 *   with no heading is a picking error waiting to be made.
 *
 *   **A cell is truncated, never wrapped, and never allowed to run into its
 *   neighbour.** A product name that overflows its column and paints over the
 *   quantity beside it produces a document that looks complete and is unreadable
 *   exactly where it matters.
 *
 *   **Footers are drawn at the end**, because "page 2 of 5" is not knowable until
 *   the last row is placed.
 */
export class DocumentBuilder {
  private page: PDFPage;
  private y: number;

  private constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
    private readonly footerLabel: string,
  ) {
    this.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  static async create(footerLabel: string): Promise<DocumentBuilder> {
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    return new DocumentBuilder(doc, regular, bold, footerLabel);
  }

  /** The masthead: who this document belongs to, and what it is. */
  header(organizationName: string, title: string, reference: string): this {
    this.page.drawText(organizationName || "Organisation", {
      x: MARGIN,
      y: this.y - 12,
      size: 10,
      font: this.bold,
      color: MUTED,
    });
    this.page.drawText(title, {
      x: MARGIN,
      y: this.y - 34,
      size: 18,
      font: this.bold,
      color: INK,
    });
    const width = this.bold.widthOfTextAtSize(reference, 12);
    this.page.drawText(reference, {
      x: PAGE_WIDTH - MARGIN - width,
      y: this.y - 32,
      size: 12,
      font: this.bold,
      color: INK,
    });
    this.y -= 48;
    return this.rule();
  }

  /** Two columns of label/value pairs — the document's facts, above the lines. */
  facts(pairs: ReadonlyArray<readonly [string, string]>): this {
    const columnWidth = CONTENT_WIDTH / 2;
    const rows = Math.ceil(pairs.length / 2);
    this.ensure(rows * 16 + 10);

    pairs.forEach((pair, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = MARGIN + column * columnWidth;
      const y = this.y - 12 - row * 16;
      this.page.drawText(pair[0], { x, y, size: 8, font: this.bold, color: MUTED });
      this.page.drawText(this.fit(pair[1], this.regular, 9, columnWidth - 96), {
        x: x + 92,
        y,
        size: 9,
        font: this.regular,
        color: INK,
      });
    });

    this.y -= rows * 16 + 10;
    return this.rule();
  }

  sectionTitle(text: string): this {
    this.ensure(24);
    this.page.drawText(text, {
      x: MARGIN,
      y: this.y - 12,
      size: 10,
      font: this.bold,
      color: INK,
    });
    this.y -= 22;
    return this;
  }

  /**
   * A table. Rows are already strings: formatting money and quantities is the
   * caller's business, and doing it here would be a second opinion about numbers
   * the rest of the module has already decided.
   */
  table(columns: readonly DocumentColumn[], rows: ReadonlyArray<readonly string[]>): this {
    const widths = this.columnWidths(columns);
    this.tableHeader(columns, widths);

    for (const row of rows) {
      if (this.y < MARGIN + 40) {
        this.newPage();
        this.tableHeader(columns, widths);
      }
      let x = MARGIN;
      columns.forEach((column, index) => {
        const width = widths[index]!;
        const text = this.fit(row[index] ?? "", this.regular, 9, width - 8);
        const textWidth = this.regular.widthOfTextAtSize(text, 9);
        this.page.drawText(text, {
          x: column.align === "right" ? x + width - 4 - textWidth : x + 4,
          y: this.y - 12,
          size: 9,
          font: this.regular,
          color: INK,
        });
        x += width;
      });
      this.y -= 16;
      this.page.drawLine({
        start: { x: MARGIN, y: this.y },
        end: { x: PAGE_WIDTH - MARGIN, y: this.y },
        thickness: 0.4,
        color: RULE,
      });
    }

    this.y -= 8;
    return this;
  }

  /** A free line of muted text — totals, counts, a signature strip. */
  note(text: string): this {
    this.ensure(18);
    this.page.drawText(this.fit(text, this.regular, 9, CONTENT_WIDTH), {
      x: MARGIN,
      y: this.y - 10,
      size: 9,
      font: this.regular,
      color: MUTED,
    });
    this.y -= 16;
    return this;
  }

  /** A scannable code for the document itself, top-right of the first page. */
  async stamp(pngDataUri: string): Promise<this> {
    const base64 = pngDataUri.slice(pngDataUri.indexOf(",") + 1);
    const image = await this.doc.embedPng(Buffer.from(base64, "base64"));
    const first = this.doc.getPage(0);
    first.drawImage(image, {
      x: PAGE_WIDTH - MARGIN - 64,
      y: PAGE_HEIGHT - MARGIN - 92,
      width: 64,
      height: 64,
    });
    return this;
  }

  async finish(): Promise<Buffer> {
    const pages = this.doc.getPages();
    pages.forEach((page, index) => {
      const label = `${this.footerLabel}   ·   Page ${index + 1} of ${pages.length}`;
      page.drawText(label, {
        x: MARGIN,
        y: MARGIN - 14,
        size: 7,
        font: this.regular,
        color: MUTED,
      });
    });
    return Buffer.from(await this.doc.save());
  }

  private rule(): this {
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y },
      thickness: 0.8,
      color: RULE,
    });
    this.y -= 14;
    return this;
  }

  private tableHeader(columns: readonly DocumentColumn[], widths: readonly number[]): void {
    this.ensure(24);
    this.page.drawRectangle({
      x: MARGIN,
      y: this.y - 16,
      width: CONTENT_WIDTH,
      height: 16,
      color: BAND,
    });
    let x = MARGIN;
    columns.forEach((column, index) => {
      const width = widths[index]!;
      const text = this.fit(column.header, this.bold, 8, width - 8);
      const textWidth = this.bold.widthOfTextAtSize(text, 8);
      this.page.drawText(text, {
        x: column.align === "right" ? x + width - 4 - textWidth : x + 4,
        y: this.y - 11,
        size: 8,
        font: this.bold,
        color: MUTED,
      });
      x += width;
    });
    this.y -= 16;
  }

  private columnWidths(columns: readonly DocumentColumn[]): number[] {
    const total = columns.reduce((sum, column) => sum + column.weight, 0) || 1;
    return columns.map((column) => (column.weight / total) * CONTENT_WIDTH);
  }

  private ensure(height: number): void {
    if (this.y - height < MARGIN) this.newPage();
  }

  private newPage(): void {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  /**
   * Truncated to fit, with an ellipsis, rather than wrapped.
   *
   * A wrapped cell changes the row height, which changes where the next row
   * starts, which is where every hand-rolled table in this codebase has gone
   * wrong. A truncated one is honest about being truncated and keeps the grid.
   */
  private fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
    // pdf-lib's standard fonts are WinAnsi-encoded and throw on anything outside
    // it. A product name with a smart quote in it would otherwise fail the whole
    // document rather than one character of it.
    const safe = text.replace(/[^\x20-\x7E]/g, "?");
    if (font.widthOfTextAtSize(safe, size) <= maxWidth) return safe;
    let cut = safe;
    while (cut.length > 1 && font.widthOfTextAtSize(`${cut}...`, size) > maxWidth) {
      cut = cut.slice(0, -1);
    }
    return `${cut}...`;
  }
}
