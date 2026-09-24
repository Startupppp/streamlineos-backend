import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const cursorSchema = z
  .object({ v: z.literal(1), publishedAt: z.string().datetime({ offset: true }), id: z.number().int().positive() })
  .strict();

export type LinkedDocumentCursor = { publishedAt: string; id: number };

export function encodeLinkedDocumentCursor(cursor: LinkedDocumentCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, publishedAt: cursor.publishedAt, id: cursor.id }), "utf8").toString("base64url");
}

export function decodeLinkedDocumentCursor(value: string): LinkedDocumentCursor {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return { publishedAt: parsed.publishedAt, id: parsed.id };
  } catch {
    throw new BadRequestException({ code: "INVALID_LINKED_DOCUMENT_CURSOR", message: "The cursor is invalid or expired." });
  }
}
