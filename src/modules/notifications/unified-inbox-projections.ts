/**
 * The unified inbox's ordering table and its column projections.
 *
 * Split out of unified-inbox.service.ts when it crossed the 500-line review limit
 * (CLAUDE.md section 7). These are data, not behaviour: `KIND_ORDER` is the fixed rank
 * the four sources interleave by, and the two `*_COLUMNS` objects are the explicit
 * projections the service selects with — backend CLAUDE.md section 3 requires the
 * `users` join to name its columns rather than pull the whole row, which still holds
 * authentication secrets. Keeping them beside the queries that use them is what makes
 * that requirement checkable in one place.
 */
import { notifications, users } from "../../db/schema";
import type {
  InboxKind,
  InboxSourcePosition,
  UnifiedInboxItem,
} from "./dto/unified-inbox.schemas";

export const KIND_ORDER: Record<InboxKind, number> = {
  notification: 0,
  broadcast: 1,
  mail: 2,
  build_approval: 3,
  module_task: 4,
};

export function stableSortItems(items: UnifiedInboxItem[]): UnifiedInboxItem[] {
  return [...items].sort((a, b) => {
    const tDiff = b.timestamp.localeCompare(a.timestamp);
    if (tDiff !== 0) return tDiff;
    const kDiff = (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99);
    if (kDiff !== 0) return kDiff;
    if (typeof a.id === "number" && typeof b.id === "number") return b.id - a.id;
    return String(b.id).localeCompare(String(a.id));
  });
}

export function lastDeliveredPosition(
  items: UnifiedInboxItem[],
  kind: InboxKind,
): InboxSourcePosition | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind !== kind) continue;
    if (typeof item.id !== "number") return null;
    return { id: item.id, t: item.timestamp };
  }
  return null;
}

export function lastDeliveredAdapterPositions(
  page: UnifiedInboxItem[],
  current: Record<string, InboxSourcePosition>,
  adapterByDedupKey: ReadonlyMap<string, string>,
  trackedKind: InboxKind,
): Record<string, InboxSourcePosition> {
  const next: Record<string, InboxSourcePosition> = { ...current };
  for (const item of page) {
    if (item.kind !== trackedKind) continue;
    const adapterKey = adapterByDedupKey.get(item.dedupKey);
    if (adapterKey === undefined) continue;
    const numId =
      typeof item.id === "number" ? item.id : Number(item.id);
    if (!Number.isSafeInteger(numId)) continue;
    next[adapterKey] = { id: numId, t: item.timestamp };
  }
  return next;
}

export function deduplicate(items: UnifiedInboxItem[]): UnifiedInboxItem[] {
  const seen = new Set<string>();
  const out: UnifiedInboxItem[] = [];
  for (const item of items) {
    if (!seen.has(item.dedupKey)) {
      seen.add(item.dedupKey);
      out.push(item);
    }
  }
  return out;
}

export const NOTIF_COLUMNS = {
  id: notifications.id,
  type: notifications.type,
  priority: notifications.priority,
  category: notifications.category,
  sourceModule: notifications.sourceModule,
  eventKey: notifications.eventKey,
  title: notifications.title,
  message: notifications.message,
  link: notifications.link,
  isRead: notifications.isRead,
  pinned: notifications.pinned,
  createdAt: notifications.createdAt,
  actorUserId: notifications.actorUserId,
} as const;

export const ACTOR_COLUMNS = {
  actorId: users.id,
  actorName: users.name,
  actorImage: users.image,
} as const;
