import { and, count, eq, gte, isNotNull, sql } from "drizzle-orm";
import { notificationDeliveries } from "../../db/schema";
import type { Db } from "../../db/drizzle.types";
import type { NotificationChannel } from "./notification.types";

export interface ProviderCaps {
  /** Max SENT deliveries on this channel per UTC day. Null = uncapped. */
  dailySendLimit: number | null;
  /** Max month-to-date `cost_amount` on this channel, minor units. Null = uncapped. */
  monthlyCostLimit: number | null;
}

export type CapVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; retryAfterMs: number };

/** Where the counting windows start. Exported so the spec drives the real boundaries. */
export function dayStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function msUntil(target: Date, now: Date): number {
  return Math.max(60_000, target.getTime() - now.getTime());
}

/**
 * PRD-C132's "backpressure", enforced.
 *
 * `daily_send_limit` and `monthly_cost_limit` are validated by
 * `dto/provider.schemas.ts`, persisted by `NotificationProvidersService` and shown in
 * the admin UI — and a repo-wide grep for either name returns exactly four sites: the
 * schema declaration and those three. NOTHING read them. An operator who set a
 * 10,000/day SMS cap after a runaway loop got 400,000 messages from the next one and
 * learned about it from the provider invoice. The product advertised a control that
 * did not exist, which is worse than not offering one.
 *
 * WINDOWS ARE UTC, DELIBERATELY. A send cap is an operational spend limit, not a
 * business date: making it follow each organisation's civil calendar would mean a
 * second read per job and a cap that resets at a different instant per tenant, and
 * "today" would then depend on the host's zone in every code path that had to agree
 * with it. UTC is one boundary, stated here, and the spec pins it.
 *
 * REQUEUE, NEVER DEAD. Hitting a cap is a throttle: the delivery is still wanted, just
 * not now. It goes back to PENDING at the window boundary with the attempt counter
 * untouched, exactly as the circuit breaker does — marking it DEAD would turn an
 * operator's budget control into lost notifications.
 */
export async function checkProviderCaps(
  db: Db,
  orgId: string,
  channel: NotificationChannel,
  caps: ProviderCaps,
  now: Date,
): Promise<CapVerdict> {
  if (caps.dailySendLimit === null && caps.monthlyCostLimit === null) return { allowed: true };

  if (caps.dailySendLimit !== null) {
    const since = dayStartUtc(now);
    const rows = await db
      .select({ sent: count() })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.orgId, orgId),
          eq(notificationDeliveries.channel, channel),
          eq(notificationDeliveries.status, "SENT"),
          isNotNull(notificationDeliveries.sentAt),
          gte(notificationDeliveries.sentAt, since),
        ),
      );
    const sent = Number(rows[0]?.sent ?? 0);
    if (sent >= caps.dailySendLimit) {
      const nextDay = new Date(since.getTime() + 24 * 60 * 60 * 1000);
      return {
        allowed: false,
        reason: `daily send limit reached for ${channel} (${sent}/${caps.dailySendLimit})`,
        retryAfterMs: msUntil(nextDay, now),
      };
    }
  }

  if (caps.monthlyCostLimit !== null) {
    const since = monthStartUtc(now);
    const rows = await db
      .select({ spent: sql<number>`coalesce(sum(${notificationDeliveries.costAmount}), 0)::int` })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.orgId, orgId),
          eq(notificationDeliveries.channel, channel),
          eq(notificationDeliveries.status, "SENT"),
          isNotNull(notificationDeliveries.sentAt),
          gte(notificationDeliveries.sentAt, since),
        ),
      );
    const spent = Number(rows[0]?.spent ?? 0);
    if (spent >= caps.monthlyCostLimit) {
      const nextMonth = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth() + 1, 1));
      return {
        allowed: false,
        reason: `monthly cost limit reached for ${channel} (${spent}/${caps.monthlyCostLimit})`,
        retryAfterMs: msUntil(nextMonth, now),
      };
    }
  }

  return { allowed: true };
}
