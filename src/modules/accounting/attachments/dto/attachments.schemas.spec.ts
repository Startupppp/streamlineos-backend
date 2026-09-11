/**
 * The attachment payload schemas are the outer boundary — the mime allowlist,
 * the size ceiling and the strict-mode rejection all live here, and the service
 * behind them trusts what they hand over. The e2e calls the service directly,
 * so without this the boundary itself would be untested.
 */
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  attachDocumentFileSchema,
  attachableDocumentTypeSchema,
  listAttachmentsSchema,
} from "./attachments.schemas";

describe("attachment payload schemas", () => {
  it("accepts every document kind the table's CHECK constraint allows", () => {
    for (const type of [
      "sales_invoice",
      "credit_note",
      "purchase_bill",
      "debit_note",
      "receipt",
      "payment",
      "journal",
    ]) {
      expect(attachableDocumentTypeSchema.parse(type)).toBe(type);
    }
    expect(() => attachableDocumentTypeSchema.parse("gl_journal")).toThrow();
    expect(() => attachableDocumentTypeSchema.parse("")).toThrow();
  });

  it("trims the file name and normalises the mime type", () => {
    expect(
      attachDocumentFileSchema.parse({
        fileName: "  vendor bill.pdf ",
        mimeType: "APPLICATION/PDF",
        contentBase64: "JVBERi0=",
      }),
    ).toEqual({
      fileName: "vendor bill.pdf",
      mimeType: "application/pdf",
      contentBase64: "JVBERi0=",
    });
  });

  it("allows only evidence formats", () => {
    for (const mimeType of ALLOWED_ATTACHMENT_MIME_TYPES) {
      expect(
        attachDocumentFileSchema.parse({ fileName: "f", mimeType, contentBase64: "AAAA" }).mimeType,
      ).toBe(mimeType);
    }
    for (const mimeType of ["application/x-sh", "text/html", "application/octet-stream"]) {
      expect(() =>
        attachDocumentFileSchema.parse({ fileName: "f", mimeType, contentBase64: "AAAA" }),
      ).toThrow();
    }
  });

  it("refuses an unknown key rather than ignoring it", () => {
    expect(() =>
      attachDocumentFileSchema.parse({
        fileName: "f",
        mimeType: "application/pdf",
        contentBase64: "AAAA",
        orgId: "someone-elses-org",
      }),
    ).toThrow();
  });

  it("caps the payload below the 3 MB JSON body limit", () => {
    // Base64 costs four characters per three bytes, so the character ceiling
    // has to sit above the byte ceiling or the cap would never bite.
    const justOver = "A".repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4096);
    expect(() =>
      attachDocumentFileSchema.parse({
        fileName: "f",
        mimeType: "application/pdf",
        contentBase64: justOver,
      }),
    ).toThrow();
  });

  it("coerces pagination and holds the 100-per-page cap", () => {
    expect(listAttachmentsSchema.parse({ page: "2", pageSize: "10" })).toEqual({
      page: 2,
      pageSize: 10,
    });
    expect(listAttachmentsSchema.parse({})).toEqual({});
    expect(() => listAttachmentsSchema.parse({ pageSize: "500" })).toThrow();
    expect(() => listAttachmentsSchema.parse({ page: "0" })).toThrow();
  });
});
