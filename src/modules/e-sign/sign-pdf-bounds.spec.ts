import { PDFDocument } from "pdf-lib";
import { SignPdfService } from "./sign-pdf.service";

async function pdf(pageCount: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage();
  return Buffer.from(await document.save());
}

describe("SignPdfService PDF bounds", () => {
  const service = new SignPdfService();

  it("rejects an external PDF over the input byte limit", async () => {
    const source = await pdf(1);
    await expect(service.getPageCount(source, { maxInputBytes: 10 })).rejects.toMatchObject({
      code: "PDF_INPUT_SIZE_LIMIT_EXCEEDED",
    });
  });

  it("rejects an external PDF over the page limit", async () => {
    await expect(service.getPageCount(await pdf(2), { maxPages: 1 })).rejects.toMatchObject({
      code: "PDF_PAGE_LIMIT_EXCEEDED",
    });
  });

  it("rejects merged output over the output byte limit", async () => {
    await expect(service.mergeDocuments([await pdf(1)], { maxBytes: 10 })).rejects.toMatchObject({
      code: "PDF_SIZE_LIMIT_EXCEEDED",
    });
  });
});
