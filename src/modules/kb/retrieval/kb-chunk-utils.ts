import { createHash } from "node:crypto";
import { Readable } from "stream";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function chunkText(text: string): string[] {
  const chunkSize = 1500;
  const overlapSize = 200;
  const maxChunks = 400;
  const chunks: string[] = [];

  if (!text || text.trim().length === 0) return chunks;

  let pos = 0;
  while (pos < text.length && chunks.length < maxChunks) {
    const end = Math.min(pos + chunkSize, text.length);
    let chunkEnd = end;

    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end);
      if (lastSpace > pos && lastSpace > pos + chunkSize - 200)
        chunkEnd = lastSpace;
    }

    const chunk = text.slice(pos, chunkEnd).trim();
    if (chunk.length > 0) chunks.push(chunk);

    if (end >= text.length) break;

    pos = Math.max(pos + 1, chunkEnd - overlapSize);
  }

  return chunks;
}

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks);
}
