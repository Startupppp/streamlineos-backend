import { PDFDocument, PDFArray, PDFStream, type PDFPage } from "pdf-lib";
import { inflateSync } from "node:zlib";

/**
 * The text actually painted on a generated PDF, page by page.
 *
 * A document builder can only be checked against what it draws, and neither the
 * saved buffer nor a `PDFPage` will answer "what does this page say": pdf-lib
 * deflates content streams and writes strings as hex tokens (`<534B55> Tj`), so
 * a plain substring search over the bytes finds nothing and quietly reports
 * that every assertion failed.
 *
 * Inflating the stream and decoding those tokens reads the document the way a
 * reader would, without reaching into the builder that produced it.
 *
 * Two limits worth knowing before trusting a result. Only `Tj` is decoded, not
 * `TJ` arrays with kerning — pdf-lib's `drawText` emits `Tj`, so this covers
 * what this codebase generates and would silently miss text from another
 * producer. And the standard fonts are WinAnsi, so the decoded string is
 * latin1: a document that draws outside that range cannot be searched for by
 * its original characters.
 */
export function pdfPageText(page: PDFPage): string {
  const contents = page.node.Contents();
  if (!contents) return "";

  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => page.node.context.lookup(ref))
      : [contents];

  const body = streams
    .filter((stream): stream is PDFStream => stream instanceof PDFStream)
    .map((stream) => {
      const raw = Buffer.from(stream.getContents());
      // Content streams are FlateDecode in practice; fall back rather than
      // throw, so an uncompressed one still reads.
      try {
        return inflateSync(raw).toString("latin1");
      } catch {
        return raw.toString("latin1");
      }
    })
    .join("\n");

  return [...body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)]
    .map(([, hex]) => Buffer.from(hex ?? "", "hex").toString("latin1"))
    .join("\n");
}

/** Every page's text, in page order. */
export async function pdfPageTexts(bytes: Buffer): Promise<string[]> {
  const loaded = await PDFDocument.load(bytes);
  return loaded.getPages().map(pdfPageText);
}
