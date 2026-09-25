import { createHash } from "node:crypto";
import {
  decodeTupleCursor,
  encodeTupleCursor,
} from "../../../common/pagination/cursor";
import type { PageFullSearchQuery } from "./dto/kb-page-search-query.schemas";

const CURSOR_ARITY = 4;
const SCOPE_TAG_LENGTH = 12;
const MAX_RANK_LENGTH = 32;
const MAX_TIMESTAMP_LENGTH = 32;
const MICROSECOND_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;

export interface KbPageSearchPosition {
  readonly rank: string;
  readonly updatedAt: string;
  readonly id: number;
}

function canonicalFilters(query: Pick<PageFullSearchQuery, "q" | "spaceId" | "status" | "type" | "verified">): string {
  return [
    query.q.trim().toLowerCase(),
    query.spaceId ?? "",
    query.status ?? "",
    query.type ?? "",
    query.verified === undefined ? "" : query.verified ? "1" : "0",
  ].join("|");
}

export function searchScopeTag(
  query: Pick<PageFullSearchQuery, "q" | "spaceId" | "status" | "type" | "verified">,
  permissionFingerprint: string,
): string {
  return createHash("sha256")
    .update(`${canonicalFilters(query)}\u0000${permissionFingerprint}`)
    .digest("hex")
    .slice(0, SCOPE_TAG_LENGTH);
}

export function encodeSearchCursor(
  scopeTag: string,
  position: KbPageSearchPosition,
): string {
  return encodeTupleCursor([
    scopeTag,
    position.rank,
    position.updatedAt,
    String(position.id),
  ]);
}

export function decodeSearchCursor(
  cursor: string | undefined,
  scopeTag: string,
): KbPageSearchPosition | null {
  if (cursor === undefined) return null;

  const parts = decodeTupleCursor(cursor, CURSOR_ARITY);
  if (parts === null) return null;

  const [tag, rank, updatedAt, rawId] = parts;
  if (tag !== scopeTag) return null;
  if (rank.length > MAX_RANK_LENGTH || !Number.isFinite(Number(rank))) return null;
  if (updatedAt.length > MAX_TIMESTAMP_LENGTH) return null;
  if (!MICROSECOND_TIMESTAMP.test(updatedAt)) return null;
  if (!/^[1-9][0-9]{0,9}$/.test(rawId)) return null;

  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id > 2_147_483_647) return null;

  return { rank, updatedAt, id };
}
