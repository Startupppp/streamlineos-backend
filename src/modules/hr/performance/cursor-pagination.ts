import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const timestampCursorPayloadSchema = z
  .object({
    createdAt: z.unknown(),
    recordId: z.number().int(),
  })
  .strict();

export interface TimestampCursor {
  createdAt: Date;
  recordId: number;
}

export function encodeTimestampCursor(value: TimestampCursor): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: value.createdAt.toISOString(),
      recordId: value.recordId,
    }),
  ).toString("base64url");
}

export function decodeTimestampCursor(cursor: string): TimestampCursor {
  try {
    const parsed = timestampCursorPayloadSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    const createdAt = new Date(String(parsed.createdAt));
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error();
    }
    return { createdAt, recordId: parsed.recordId };
  } catch {
    throw new BadRequestException("Invalid pagination cursor");
  }
}
