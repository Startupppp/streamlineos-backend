import { createHash } from "node:crypto";
import { Readable } from "stream";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const KB_CHUNK_SIZE_CHARS = 1500;
export const KB_CHUNK_OVERLAP_CHARS = 200;
export const KB_MAX_CHUNKS_PER_DOCUMENT = 400;
export const KB_CHUNK_WORD_LOOKBACK_CHARS = 200;
export const KB_CHUNK_PARAGRAPH_LOOKBACK_CHARS = Math.round(KB_CHUNK_SIZE_CHARS * 0.4);

export function chunkText(text: string): string[] {
  const chunks: string[] = [];

  if (!text || text.trim().length === 0) return chunks;

  let pos = 0;
  while (pos < text.length && chunks.length < KB_MAX_CHUNKS_PER_DOCUMENT) {
    const end = Math.min(pos + KB_CHUNK_SIZE_CHARS, text.length);
    const boundary =
      end < text.length ? chunkBoundary(text, pos, end) : { offset: end, kind: "flow" as const };

    const chunk = text.slice(pos, boundary.offset).trim();
    if (chunk.length > 0) chunks.push(chunk);

    if (end >= text.length) break;

    pos =
      boundary.kind === "paragraph"
        ? boundary.offset
        : Math.max(pos + 1, boundary.offset - KB_CHUNK_OVERLAP_CHARS);
  }

  return chunks;
}

type ChunkBoundary = { offset: number; kind: "paragraph" | "flow" };

function chunkBoundary(text: string, pos: number, end: number): ChunkBoundary {
  const paragraph = text.lastIndexOf("\n\n", end);
  if (paragraph > pos && paragraph > end - KB_CHUNK_PARAGRAPH_LOOKBACK_CHARS)
    return { offset: paragraph, kind: "paragraph" };

  const line = text.lastIndexOf("\n", end);
  if (line > pos && line > end - KB_CHUNK_WORD_LOOKBACK_CHARS)
    return { offset: line, kind: "flow" };

  const word = text.lastIndexOf(" ", end);
  if (word > pos && word > end - KB_CHUNK_WORD_LOOKBACK_CHARS)
    return { offset: word, kind: "flow" };

  return { offset: end, kind: "flow" };
}

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
