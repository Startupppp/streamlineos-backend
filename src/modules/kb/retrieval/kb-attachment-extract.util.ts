const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function isExtractableMime(mimeType: string | null): boolean {
  const mime = mimeType ?? "";
  return (
    mime === "application/pdf" ||
    mime === DOCX_MIME ||
    mime.startsWith("text/")
  );
}

export async function extractAttachmentText(
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
