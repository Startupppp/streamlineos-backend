import { createHash } from "node:crypto";
import {
  decodeTupleCursor,
  encodeTupleCursor,
} from "../../../../common/pagination/cursor";
import type {
  KbPageCollectionQuery,
  KbPageCollectionSort,
} from "./knowledge-collection.types";

const CURSOR_ARITY = 3;
const SCOPE_TAG_LENGTH = 12;
const MAX_SORT_VALUE_LENGTH = 512;
const MICROSECOND_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;

export interface KbPageCollectionPosition {
  readonly sortValue: string;
  readonly id: number;
}

export function sortUsesTimestamp(sort: KbPageCollectionSort): boolean {
  return sort === "updated_desc" || sort === "created_desc";
}

function canonicalFilters(query: KbPageCollectionQuery): string {
  return [
    query.q ?? "",
    query.spaceId ?? "",
    query.projectId ?? "",
    query.owner ?? "",
    query.sharedWithMe === true ? "1" : "",
    query.status === undefined ? "" : [...query.status].sort().join("."),
    query.verified === undefined ? "" : query.verified ? "1" : "0",
    query.deleted === true ? "1" : "0",
    query.sort,
  ].join("|");
}

export function collectionScopeTag(
  query: KbPageCollectionQuery,
  permissionFingerprint: string,
): string {
  return createHash("sha256")
    .update(`${canonicalFilters(query)}\u0000${permissionFingerprint}`)
    .digest("hex")
    .slice(0, SCOPE_TAG_LENGTH);
}

const SORT_VALUE_SENTINEL = "v";

export function encodeCollectionCursor(
  scopeTag: string,
  position: KbPageCollectionPosition,
): string {
  return encodeTupleCursor([
    scopeTag,
    `${SORT_VALUE_SENTINEL}${position.sortValue}`,
    String(position.id),
  ]);
}

export function decodeCollectionCursor(
  cursor: string | undefined,
  scopeTag: string,
  sort: KbPageCollectionSort,
): KbPageCollectionPosition | null {
  if (cursor === undefined) return null;

  const parts = decodeTupleCursor(cursor, CURSOR_ARITY);
  if (parts === null) return null;

  const [tag, encodedSortValue, rawId] = parts;
  if (tag !== scopeTag) return null;
  if (!encodedSortValue.startsWith(SORT_VALUE_SENTINEL)) return null;
  const sortValue = encodedSortValue.slice(SORT_VALUE_SENTINEL.length);
  if (sortValue.length > MAX_SORT_VALUE_LENGTH) return null;
  if (sortUsesTimestamp(sort) && !MICROSECOND_TIMESTAMP.test(sortValue)) {
    return null;
  }
  if (!/^[1-9][0-9]{0,9}$/.test(rawId)) return null;

  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id > 2_147_483_647) return null;

  return { sortValue, id };
}
