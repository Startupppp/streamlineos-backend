const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Whether bytes of this media type can be turned into text at all.
 *
 * Asked before spending the extraction, and again before recording that an
 * extraction "failed": a PNG resume did not fail to parse, it was never
 * parseable, and reporting the two the same way makes a product decision look
 * like an outage.
 */
export function isExtractableMime(mimeType: string | null): boolean {
  const mime = mimeType ?? "";
  return (
    mime === "application/pdf" ||
    mime === DOCX_MIME ||
    mime.startsWith("text/")
  );
}

/**
 * Plain text out of an uploaded document, or "" when the type carries none.
 *
 * Shared by KB attachment indexing and recruitment resume intake. It lives in
 * `common/` rather than inside either module because the second caller would
 * otherwise have had to import the first module's util by name — a
 * `kb-attachment-extract` import from the hiring desk — and because the
 * dynamic `import()`s below keep `pdf-parse` and `mammoth` out of the boot
 * path of every process that never reads a document.
 */
export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string | null,
): Promise<string> {
  const mime = mimeType ?? "";
  if (mime === "application/pdf") {
    const pdf = (await import("pdf-parse")).default;
    const result = await pdf(buffer);
    return result.text ?? "";
  }
  if (mime === DOCX_MIME) {
    const { extractRawText } = await import("mammoth");
    const result = await extractRawText({ buffer });
    return result.value ?? "";
  }
  if (mime.startsWith("text/")) {
    return buffer.toString("utf-8");
  }
  return "";
}
