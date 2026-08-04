import { BadRequestException } from "@nestjs/common";

export interface TimestampCursor {
  createdAt: Date;
  id: number;
}

export function encodeTimestampCursor(value: TimestampCursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: value.createdAt.toISOString(), id: value.id }),
  ).toString("base64url");
}

export function decodeTimestampCursor(cursor: string): TimestampCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    const createdAt = new Date(String(parsed.createdAt));
    if (!Number.isInteger(parsed.id) || Number.isNaN(createdAt.getTime())) throw new Error();
    return { createdAt, id: parsed.id as number };
  } catch {
    throw new BadRequestException("Invalid pagination cursor");
  }
}
