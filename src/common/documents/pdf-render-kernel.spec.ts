import { PDFDocument } from "pdf-lib";
import {
  PdfRenderError,
  renderBoundedPdf,
  type PdfRenderLimits,
} from "./pdf-render-kernel";

const TEST_LIMITS: PdfRenderLimits = {
  maxBytes: 10_000,
  maxInputBytes: 10_000,
  maxPages: 2,
  maxWorkUnits: 10,
  timeoutMs: 1_000,
};

describe("renderBoundedPdf", () => {
  it("creates a loadable PDF inside the declared limits", async () => {
    const bytes = await renderBoundedPdf(({ document, addPage, checkpoint }) => {
      checkpoint(2);
      addPage([100, 100]);
      expect(document.getPageCount()).toBe(1);
    }, TEST_LIMITS);

    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });

  it("rejects excess work before rendering can grow without bound", async () => {
    await expect(
      renderBoundedPdf(({ checkpoint }) => checkpoint(11), TEST_LIMITS),
    ).rejects.toMatchObject({ code: "PDF_WORK_LIMIT_EXCEEDED" });
  });

  it("rejects excess pages even when a renderer uses the document directly", async () => {
    await expect(
      renderBoundedPdf(({ document }) => {
        document.addPage();
        document.addPage();
        document.addPage();
      }, TEST_LIMITS),
    ).rejects.toMatchObject({ code: "PDF_PAGE_LIMIT_EXCEEDED" });
  });

  it("rejects oversized output", async () => {
    await expect(
      renderBoundedPdf(({ addPage }) => addPage(), { ...TEST_LIMITS, maxBytes: 10 }),
    ).rejects.toMatchObject({ code: "PDF_SIZE_LIMIT_EXCEEDED" });
  });

  it("rejects oversized input before parsing it", async () => {
    const { loadBoundedPdfSession } = await import("./pdf-render-kernel");
    await expect(
      loadBoundedPdfSession(Buffer.alloc(11), { ...TEST_LIMITS, maxInputBytes: 10 }),
    ).rejects.toMatchObject({ code: "PDF_INPUT_SIZE_LIMIT_EXCEEDED" });
  });

  it("rejects an input document with too many pages", async () => {
    const source = await PDFDocument.create();
    source.addPage();
    source.addPage();
    source.addPage();
    const { loadBoundedPdfSession } = await import("./pdf-render-kernel");

    await expect(
      loadBoundedPdfSession(Buffer.from(await source.save()), TEST_LIMITS),
    ).rejects.toMatchObject({ code: "PDF_PAGE_LIMIT_EXCEEDED" });
  });

  it("does not expose renderer errors or document content", async () => {
    const secret = "bank-token-do-not-log";

    const error = await renderBoundedPdf(() => {
      throw new Error(secret);
    }, TEST_LIMITS).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PdfRenderError);
    expect(String(error)).not.toContain(secret);
    expect((error as PdfRenderError).code).toBe("PDF_RENDER_FAILED");
  });

  it("enforces the deadline at cooperative checkpoints", async () => {
    await expect(
      renderBoundedPdf(({ checkpoint }) => {
        const until = Date.now() + 5;
        while (Date.now() < until) {
          // Deliberately occupy this test render until its deadline passes.
        }
        checkpoint();
      }, { ...TEST_LIMITS, timeoutMs: 1 }),
    ).rejects.toMatchObject({ code: "PDF_RENDER_TIMEOUT" });
  });
});
