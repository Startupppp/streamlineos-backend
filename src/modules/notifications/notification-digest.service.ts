import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  notificationDigestItems,
  notificationDigestRuns,
  notificationPreferences,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { NotificationsService } from "./notifications.service";
import type { NotificationChannel } from "./notification.types";

export interface DigestFlushResult {
  windows: number;
  itemsFlushed: number;
  notificationsCreated: number;
}

const DIGEST_FLUSH_CHUNK = 500;

const WINDOW_MS: Record<string, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/**
 * PIPE-008 and PIPE-004.
 *
 * `digestMode` was a stored preference with no runtime effect — a user who chose
 * "daily" received nothing at all. Dedupe was also first-write-wins, so fifteen
 * comments in five minutes produced one notification about comment #1 and dropped the
 * other fourteen without trace.
 *
 * Both are the same missing thing: somewhere to hold items between the event and the
 * send. `enqueue` accumulates and coalesces; `flushDue` turns each ripe window into a
 * single aggregated notification.
 */
@Injectable()
export class NotificationDigestService {
  private readonly logger = new Logger(NotificationDigestService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  static windowMsFor(mode: string | null | undefined): number | null {
    return mode ? (WINDOW_MS[mode] ?? null) : null;
  }

  /**
   * Adds an occurrence. A repeat on the same `coalesceKey` inside an open window
   * increments the count and moves `lastSeenAt` — it does not open a second row and
   * does not overwrite the first, which is the whole point of the change.
   */
  async enqueue(input: {
    orgId: string;
    membershipId: number;
    channel: NotificationChannel;
    eventKey: string;
    entityType?: string | null;
    entityId?: string | null;
    title: string;
    message: string;
    link?: string | null;
    windowMs: number;
  }): Promise<void> {
    const coalesceKey = `${input.eventKey}:${input.entityType ?? ""}:${input.entityId ?? ""}`;
    const now = new Date();
    await this.db
      .insert(notificationDigestItems)
      .values({
        orgId: input.orgId,
        membershipId: input.membershipId,
        channel: input.channel,
        eventKey: input.eventKey,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        title: input.title,
        message: input.message,
        link: input.link ?? null,
        coalesceKey,
        deliverAfter: new Date(now.getTime() + input.windowMs),
      })
      .onConflictDoUpdate({
        target: [
          notificationDigestItems.orgId,
          notificationDigestItems.membershipId,
          notificationDigestItems.channel,
          notificationDigestItems.coalesceKey,
        ],
        targetWhere: isNull(notificationDigestItems.flushedAt),
        set: {
          occurrenceCount: sql`${notificationDigestItems.occurrenceCount} + 1`,
          lastSeenAt: now,
          // Deliberately does NOT extend deliverAfter: a continuously active thread
          // would otherwise never reach its window and the digest would never arrive.
          message: input.message,
        },
      });
  }

  /**
   * Flushes every ripe window, per tenant. `notification_digest_runs` carries a unique
   * on (org, user, channel, window) so a retried flush is a no-op rather than a second
   * digest — the sweep is at-least-once like everything else here.
   */
  async flushDue(): Promise<DigestFlushResult> {
    const result: DigestFlushResult = { windows: 0, itemsFlushed: 0, notificationsCreated: 0 };
    const now = new Date();

    await forEachOrg(this.db, "notification-digest-flush", async (tx, orgId) => {
      const due = await tx
        .select({ item: notificationDigestItems, userId: organizationMembers.userId })
        .from(notificationDigestItems)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.orgId, notificationDigestItems.orgId),
            eq(organizationMembers.id, notificationDigestItems.membershipId),
          ),
        )
        .where(
          and(
            eq(notificationDigestItems.orgId, orgId),
            isNull(notificationDigestItems.flushedAt),
            lte(notificationDigestItems.deliverAfter, now),
          ),
        )
        .limit(1000);
      if (due.length === 0) return;

      // Keyed by a joined string but carrying the parts, because a user id is opaque
      // text: splitting the key back apart on ":" would corrupt any id containing one.
      const byUser = new Map<
        string,
        { membershipId: number; userId: string; channel: NotificationChannel; items: Array<(typeof due)[number]["item"]> }
      >();
      for (const row of due) {
        const item = row.item;
        const key = `${item.membershipId}\u0000${item.channel}`;
        const bucket = byUser.get(key);
        if (bucket) bucket.items.push(item);
        else byUser.set(key, {
          membershipId: item.membershipId,
          userId: row.userId,
          channel: item.channel,
          items: [item],
        });
      }

      // The latest deadline in each batch, not an arbitrary member's: windowEnd is the
      // once-per-window uniqueness key, so it has to be a deterministic function of
      // the batch or two concurrent sweeps would each insert their own "window".
      const windows = [...byUser.values()]
        .filter((bucket) => bucket.items.length > 0)
        .map((bucket) => ({
          ...bucket,
          windowEnd: bucket.items.reduce(
            (latest, i) => (i.deliverAfter > latest ? i.deliverAfter : latest),
            bucket.items[0]?.deliverAfter ?? now,
          ),
        }));
      if (windows.length === 0) return;

      /*
       * One insert for every ripe window instead of one per user. The conflict
       * key is (org, user, channel, windowEnd), so the returned rows are exactly
       * the windows this sweep won — a concurrent sweep's windows come back
       * absent, which is the same signal the per-row RETURNING gave.
       */
      const claimed = await tx
        .insert(notificationDigestRuns)
        .values(
          windows.map((w) => ({
            orgId,
            userId: w.userId,
            channel: w.channel,
            windowEnd: w.windowEnd,
            itemCount: w.items.length,
          })),
        )
        .onConflictDoNothing({
          target: [
            notificationDigestRuns.orgId,
            notificationDigestRuns.userId,
            notificationDigestRuns.channel,
            notificationDigestRuns.windowEnd,
          ],
        })
        .returning({
          userId: notificationDigestRuns.userId,
          channel: notificationDigestRuns.channel,
          windowEnd: notificationDigestRuns.windowEnd,
        });
      const claimedKeys = new Set(
        claimed.map((row) => `${row.userId}\u0000${row.channel}\u0000${row.windowEnd.getTime()}`),
      );

      for (const w of windows) {
        const first = w.items[0];
        if (!first) continue;
        if (claimedKeys.has(`${w.userId}\u0000${w.channel}\u0000${w.windowEnd.getTime()}`)) {
          await this.notifications.create({
            orgId,
            userId: w.userId,
            category: "SYSTEM",
            sourceModule: "notifications",
            title: summarise(w.items),
            message: w.items
              .slice(0, 10)
              .map((i) => (i.occurrenceCount > 1 ? `${i.title} (${i.occurrenceCount}×)` : i.title))
              .join("\n"),
            link: w.items.length === 1 ? (first.link ?? undefined) : "/notifications",
          });
          result.notificationsCreated += 1;
        }
        result.itemsFlushed += w.items.length;
        result.windows += 1;
      }

      /*
       * The flush is one statement for every item the sweep read, keyed on the
       * ids it already holds. Per-channel scoping is preserved because those ids
       * ARE the (membership, channel) rows the buckets were built from — the
       * predicate the loop rebuilt per bucket selected the same set.
       */
      const flushIds = due.map((row) => row.item.id);
      for (let offset = 0; offset < flushIds.length; offset += DIGEST_FLUSH_CHUNK)
        await tx
          .update(notificationDigestItems)
          .set({ flushedAt: now })
          .where(
            and(
              eq(notificationDigestItems.orgId, orgId),
              inArray(
                notificationDigestItems.id,
                flushIds.slice(offset, offset + DIGEST_FLUSH_CHUNK),
              ),
              isNull(notificationDigestItems.flushedAt),
            ),
          );
    });

    if (result.windows > 0) {
      this.logger.log(
        `DIGEST: ${result.windows} window(s), ${result.itemsFlushed} item(s), ${result.notificationsCreated} notification(s)`,
      );
    }
    return result;
  }
}

/** "3 new comments on Ticket X" rather than repeating the first title verbatim. */
function summarise(items: Array<{ title: string; occurrenceCount: number }>): string {
  const total = items.reduce((sum, i) => sum + i.occurrenceCount, 0);
  if (items.length === 1 && total === 1) return items[0]?.title ?? "New notification";
  if (items.length === 1) return `${total} updates: ${items[0]?.title ?? ""}`.trim();
  return `${total} new notifications`;
}
