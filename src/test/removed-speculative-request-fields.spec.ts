import { attachmentSchema } from "../modules/build/core/dto/ticket.schemas";
import { sectionQuerySchema } from "../modules/hr/payroll-inputs/dto/payroll-inputs.schemas";
import { policyPreviewSchema } from "../modules/payroll/setup/dto/setup.schemas";
import { kbAskSchema } from "../modules/support/core/dto/support-kb.schemas";

/**
 * Four request fields were accepted by validation, carried by the request and
 * then discarded by the handler. Each was removed from its contract rather
 * than honoured, because nothing in the product asked for it (§5 of report
 * 08c). A removal only counts if the boundary now REJECTS the field — a bare
 * z.object would strip it silently, which turns a removed field back into the
 * same no-op it was. These assertions pin `.strict()` on each of the four.
 */
describe("removed speculative request fields are rejected, not stripped", () => {
  it("attachmentSchema rejects fileKey — build stores the storage key in fileUrl", () => {
    const base = { fileName: "spec.pdf", fileUrl: "tickets/abc.pdf", fileSize: 10, mimeType: "application/pdf" };
    expect(attachmentSchema.safeParse(base).success).toBe(true);
    const withField = attachmentSchema.safeParse({ ...base, fileKey: "tickets/abc.pdf" });
    expect(withField.success).toBe(false);
    expect(JSON.stringify(withField.error?.issues)).toContain("fileKey");
  });

  it("sectionQuerySchema rejects preview — no snapshot preview mode exists", () => {
    expect(sectionQuerySchema.safeParse({ limit: 25 }).success).toBe(true);
    const withField = sectionQuerySchema.safeParse({ limit: 25, preview: "true" });
    expect(withField.success).toBe(false);
    expect(JSON.stringify(withField.error?.issues)).toContain("preview");
  });

  it("policyPreviewSchema rejects currency — the preview computes nothing in a currency", () => {
    expect(policyPreviewSchema.safeParse({ toggleOverrides: {}, country: "IN" }).success).toBe(true);
    const withField = policyPreviewSchema.safeParse({ toggleOverrides: {}, country: "IN", currency: "USD" });
    expect(withField.success).toBe(false);
    expect(JSON.stringify(withField.error?.issues)).toContain("currency");
  });

  it("kbAskSchema rejects articleId — article-scoped ask is POST /kb/articles/:articleId/ai/ask", () => {
    expect(kbAskSchema.safeParse({ question: "how do I reset my password" }).success).toBe(true);
    const withField = kbAskSchema.safeParse({ question: "how do I reset my password", articleId: 3 });
    expect(withField.success).toBe(false);
    expect(JSON.stringify(withField.error?.issues)).toContain("articleId");
  });
});
