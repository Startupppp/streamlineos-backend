import { and, isNull, lt, sql } from "drizzle-orm";
import { chatChannels } from "../../db/schema";

export function decodeChannelCursor(raw: string | null): { lma: Date | null; id: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["id"] !== "number") return null;
    if (obj["lma"] !== null && typeof obj["lma"] !== "string") return null;
    return {
      lma: typeof obj["lma"] === "string" ? new Date(obj["lma"]) : null,
      id: obj["id"] as number,
    };
  } catch {
    return null;
  }
}

export function encodeChannelCursor(lma: Date | null, id: number): string {
  return Buffer.from(JSON.stringify({ lma: lma?.toISOString() ?? null, id }), "utf8").toString("base64url");
}

export function channelKeysetWhere(cursor: { lma: Date | null; id: number } | null) {
  if (!cursor) return undefined;
  const { lma, id } = cursor;
  if (lma !== null) {
    return sql`(
      ${chatChannels.lastMessageAt} < ${lma.toISOString()}::timestamptz
      OR (${chatChannels.lastMessageAt} = ${lma.toISOString()}::timestamptz AND ${chatChannels.id} < ${id})
      OR ${chatChannels.lastMessageAt} IS NULL
    )`;
  }
  return and(isNull(chatChannels.lastMessageAt), lt(chatChannels.id, id));
}
