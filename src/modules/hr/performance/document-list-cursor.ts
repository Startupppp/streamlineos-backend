import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const CURSOR_VERSION = 1;

const documentListCursorSchema = z
  .object({
    v: z.literal(CURSOR_VERSION),
    createdAt: z.string().datetime({ offset: true }),
    documentId: z.number().int().positive(),
  })
  .strict();

export type DocumentListCursor = {
  createdAt: string;
  documentId: number;
};

export function encodeDocumentListCursor(cursor: DocumentListCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: CURSOR_VERSION,
      createdAt: cursor.createdAt,
      documentId: cursor.documentId,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeDocumentListCursor(value: string): DocumentListCursor {
  try {
    const parsed = documentListCursorSchema.safeParse(JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ));
    if (!parsed.success) {
      throw new Error("invalid cursor payload");
    }

    return {
      createdAt: parsed.data.createdAt,
      documentId: parsed.data.documentId,
    };
  } catch {
    throw new BadRequestException({
      code: "INVALID_DOCUMENT_CURSOR",
      message: "The document list cursor is invalid or expired.",
    });
  }
}
