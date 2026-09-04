export const FILE_SIGNATURES: Record<string, number[][]> = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47]],
  "image/gif": [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]],
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]],
  "application/msword": [[0xd0, 0xcf, 0x11, 0xe0]],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [[0x50, 0x4b, 0x03, 0x04]],
  "application/vnd.ms-excel": [[0xd0, 0xcf, 0x11, 0xe0]],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [[0x50, 0x4b, 0x03, 0x04]],
  "application/vnd.ms-powerpoint": [[0xd0, 0xcf, 0x11, 0xe0]],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [[0x50, 0x4b, 0x03, 0x04]],
  "application/zip": [[0x50, 0x4b, 0x03, 0x04]],
  "video/webm": [[0x1a, 0x45, 0xdf, 0xa3]],
  "video/ogg": [[0x4f, 0x67, 0x67, 0x53]],
  "application/x-zip-compressed": [[0x50, 0x4b, 0x03, 0x04]],
  "audio/mpeg": [[0x49, 0x44, 0x33], [0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2]],
  "audio/mp3": [[0x49, 0x44, 0x33], [0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2]],
  "audio/ogg": [[0x4f, 0x67, 0x67, 0x53]],
};

function hasPrefixAt(buffer: Buffer, sig: number[], offset: number): boolean {
  if (buffer.length < offset + sig.length) return false;
  return sig.every((byte, i) => buffer[offset + i] === byte);
}

export function validateMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "text/plain" || mimeType === "text/csv") return true;

  if (
    mimeType === "video/mp4" ||
    mimeType === "video/quicktime" ||
    mimeType === "audio/mp4" ||
    mimeType === "audio/x-m4a"
  ) {
    return hasPrefixAt(buffer, [0x66, 0x74, 0x79, 0x70], 4);
  }

  if (mimeType === "audio/wav") {
    return (
      hasPrefixAt(buffer, [0x52, 0x49, 0x46, 0x46], 0) &&
      hasPrefixAt(buffer, [0x57, 0x41, 0x56, 0x45], 8)
    );
  }

  if (mimeType === "image/webp") {
    return (
      hasPrefixAt(buffer, [0x52, 0x49, 0x46, 0x46], 0) &&
      hasPrefixAt(buffer, [0x57, 0x45, 0x42, 0x50], 8)
    );
  }

  /**
   * Fail closed. Returning true for a MIME type this table does not know made
   * the whole check opt-in from the caller's side: a declared
   * `application/x-anything` skipped magic-byte validation entirely, which is
   * the one input an attacker fully controls. An accepted type must be a type
   * this file can actually verify.
   */
  const signatures = FILE_SIGNATURES[mimeType];
  if (!signatures) return false;
  return signatures.some((sig) => hasPrefixAt(buffer, sig, 0));
}
