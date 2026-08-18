import { BadRequestException } from "@nestjs/common";

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
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      recordId?: unknown;
    };
    const createdAt = new Date(String(parsed.createdAt));
    if (!Number.isInteger(parsed.recordId) || Number.isNaN(createdAt.getTime())) {
      throw new Error();
    }
    return { createdAt, recordId: parsed.recordId as number };
  } catch {
    throw new BadRequestException("Invalid pagination cursor");
  }
}
