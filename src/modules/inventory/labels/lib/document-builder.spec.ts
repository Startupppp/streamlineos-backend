import { PDFDocument } from "pdf-lib";
import { DocumentBuilder } from "./document-builder";
import { pdfPageText } from "../../../../../test/helpers/pdf-text";

describe("DocumentBuilder", () => {
  describe("text the tenant supplies", () => {
    /**
     * An organisation name is tenant free text. `fit` exists because pdf-lib's
     * standard fonts are WinAnsi-encoded and throw on anything outside it —
     * its own comment says a smart quote "would otherwise fail the whole
     * document rather than one character of it".
     *
     * That reasoning does not stop at the table. An organisation called
     * "Café Foods" or one written in Devanagari is not an edge case in an
     * Indian warehouse product; it is a customer. If the masthead throws, every
     * goods-receipt note and pick list for that tenant fails to render — not
     * degraded, absent.
     */
    it("renders a masthead for an organisation whose name is outside WinAnsi", async () => {
      // Devanagari, not an accent. "Café" encodes fine — é is WinAnsi 0xE9 —
      // so it proves nothing. This module ships India packs (E1–E6), which
      // makes a Hindi trading name an ordinary customer.
      const builder = await DocumentBuilder.create("StreamlineOS");
      builder.header("श्री राम ट्रेडर्स", "Goods Receipt Note", "GRN-000123");

      const bytes = await builder.finish();

      const loaded = await PDFDocument.load(bytes);
      expect(loaded.getPageCount()).toBe(1);
    });

    it("renders a section title that is outside WinAnsi", async () => {
      const builder = await DocumentBuilder.create("StreamlineOS");
      builder.header("Acme", "Goods Receipt Note", "GRN-1");
      builder.sectionTitle("प्राप्त वस्तुएं");

      const bytes = await builder.finish();

      const loaded = await PDFDocument.load(bytes);
      expect(loaded.getPageCount()).toBe(1);
    });
  });

  describe("a table that outgrows one page", () => {
    const COLUMNS = [
      { header: "SKU", weight: 20 },
      { header: "DESCRIPTION", weight: 50 },
      { header: "QTY", weight: 15, align: "right" as const },
      { header: "UOM", weight: 15 },
    ];

    function rows(count: number): string[][] {
      return Array.from({ length: count }, (_, i) => [
        `SKU-${i}`,
        `Product number ${i}`,
        String(i),
        "EA",
      ]);
    }

    /**
     * The promise the class leads with, and the one a picker depends on: a pick
     * list that runs to three pages is read one page at a time, on a trolley,
     * and a column of bare numbers with no heading is a picking error waiting
     * to happen.
     */
    it("repeats the column headers on every page", async () => {
      const builder = await DocumentBuilder.create("StreamlineOS");
      builder.header("Acme", "Pick List", "PL-1");
      builder.table(COLUMNS, rows(120));

      const loaded = await PDFDocument.load(await builder.finish());
      expect(loaded.getPageCount()).toBeGreaterThan(1);

      for (const [index, page] of loaded.getPages().entries()) {
        const text = pdfPageText(page);
        for (const column of COLUMNS) {
          expect(`page ${index + 1}: ${text}`).toContain(column.header);
        }
      }
    });

    /**
     * Every row reaches paper. A table that silently drops the rows that did
     * not fit is worse than one that refuses, because the sheet looks complete.
     */
    it("carries every row onto some page", async () => {
      const builder = await DocumentBuilder.create("StreamlineOS");
      builder.header("Acme", "Pick List", "PL-1");
      builder.table(COLUMNS, rows(120));

      const loaded = await PDFDocument.load(await builder.finish());
      const everything = loaded.getPages().map(pdfPageText).join("\n");

      expect(everything).toContain("SKU-0");
      expect(everything).toContain("SKU-119");
    });

    it("stops before a stateful builder exceeds its page limit", async () => {
      const builder = await DocumentBuilder.create("StreamlineOS", { maxPages: 1 });
      builder.header("Acme", "Pick List", "PL-1");

      expect(() => builder.table(COLUMNS, rows(120))).toThrow(
        expect.objectContaining({ code: "PDF_PAGE_LIMIT_EXCEEDED" }),
      );
    });

    it("rejects a stateful builder output over its byte limit", async () => {
      const builder = await DocumentBuilder.create("StreamlineOS", { maxBytes: 10 });
      builder.header("Acme", "Pick List", "PL-1");

      await expect(builder.finish()).rejects.toMatchObject({
        code: "PDF_SIZE_LIMIT_EXCEEDED",
      });
    });
  });
});
