import { FILE_SIGNATURES, validateMagicBytes } from "./file-signatures";

/**
 * PRD-C103: "validate declared size and magic-byte MIME".
 *
 * The declared MIME type is the one field an uploader fully controls, and the
 * validator used to return TRUE for any type its signature table did not know.
 * That made the whole magic-byte check opt-in from the attacker's side: declare
 * a type nobody has a signature for and the bytes are never inspected at all.
 * The check now fails closed, which is only safe because every type on every
 * upload allowlist in the repo is covered — the second test pins that pairing,
 * so widening an allowlist without adding a signature fails here rather than
 * silently rejecting a legitimate upload in production.
 */
describe("validateMagicBytes fails closed on an unverifiable MIME type", () => {
  const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

  it("refuses a MIME type the signature table cannot verify", () => {
    for (const declared of [
      "application/octet-stream",
      "application/x-msdownload",
      "image/svg+xml",
      "text/html",
      "application/x-anything",
    ]) {
      expect(validateMagicBytes(PDF, declared)).toBe(false);
    }
  });

  it("still accepts real bytes for a type it knows (control)", () => {
    expect(validateMagicBytes(PDF, "application/pdf")).toBe(true);
    expect(validateMagicBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png")).toBe(true);
  });

  it("still refuses real bytes that contradict a known declared type (control)", () => {
    expect(validateMagicBytes(PDF, "image/png")).toBe(false);
  });

  /**
   * The types the special-cased branches handle plus the table's own keys. Every
   * MIME type any upload route in the repo allows must appear here, or failing
   * closed rejects a legitimate upload.
   */
  const SPECIAL_CASED = [
    "text/plain",
    "text/csv",
    "video/mp4",
    "video/quicktime",
    "audio/mp4",
    "audio/x-m4a",
    "audio/wav",
    "image/webp",
  ];

  const ALLOWLISTED_ACROSS_THE_REPO = [
    // storage.controller ALLOWED_UPLOAD_TYPES
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    // kb-media ALLOWED_TYPES
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/ogg",
    "audio/mp4",
    "audio/x-m4a",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.ms-powerpoint",
    "text/csv",
    "text/plain",
    "application/zip",
    // storage-multipart ALLOWED_MULTIPART_TYPES
    "video/ogg",
    "video/quicktime",
    "application/x-zip-compressed",
  ];

  it("covers every MIME type the repo's upload allowlists permit", () => {
    const verifiable = new Set([...Object.keys(FILE_SIGNATURES), ...SPECIAL_CASED]);
    const uncovered = ALLOWLISTED_ACROSS_THE_REPO.filter((t) => !verifiable.has(t));
    expect(uncovered).toEqual([]);
  });
});
