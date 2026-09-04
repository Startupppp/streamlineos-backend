import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import * as webpush from "web-push";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { chatChannelMembers, organizationMembers } from "../../db/schema";
import type { PushPayload } from "./dto/realtime.schemas";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { ExternalEffectLedger } from "../../common/outbox/external-effect-ledger";
import { boundedMap } from "../../common/async/bounded-map";
import { logger } from "../../common/logger/logger.service";
import {
  PUSH_SUBSCRIPTION_BATCH,
  deleteExpiredSubscriptions,
  loadSubscriptionsForPage,
  loadSubscriptionsForUser,
  type PushSubscriptionRow,
} from "./push-subscription-store";

const EXPIRED_STATUS = new Set([404, 410]);

/**
 * Per-channel-message preferences that mean "no general push". Mirrors
 * `SUPPRESSED_GENERAL_PREFERENCES` in `chat-notifications.service.ts`, which is
 * the same product decision applied to the Ably path.
 */
const PUSH_SUPPRESSING_PREFERENCES = new Set(["NOTHING", "MENTIONS"]);

/**
 * How many device pushes one message may have open at once. Matches
 * `PUBLISH_CONCURRENCY` on the Ably fan-out, and is chosen against the pool
 * rather than the audience: each `sendToUser` takes a connection for its
 * subscription read and another for the effect-ledger write, so the ceiling has
 * to sit comfortably under `DB_POOL_MAX` (10-20) for the rest of the request
 * path to keep making progress while a large channel drains.
 */
export const PUSH_FANOUT_CONCURRENCY = 16;

@Injectable()
export class WebPushService {
  private readonly publicKey: string | undefined;
  private readonly privateKey: string | undefined;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly effects: ExternalEffectLedger,
  ) {
    this.publicKey = this.config.VAPID_PUBLIC_KEY?.trim();
    this.privateKey = this.config.VAPID_PRIVATE_KEY?.trim();
    if (this.publicKey && this.privateKey)
      webpush.setVapidDetails(this.vapidSubject(), this.publicKey, this.privateKey);
  }

  get configured(): boolean {
    return Boolean(this.publicKey && this.privateKey);
  }

  /**
   * A deployment without VAPID keys used to make this path THROW whenever it was
   * called with an effect (`throw new Error("Web Push is not configured")`), and
   * `ChatMessageFanoutService.dispatchDeferred` runs it inside
   * `ExternalEffectLedger.execute`. The ledger records FAILED and rethrows, so
   * the chat-message outbox event retried and finally dead-lettered — on every
   * message, forever, for a condition no retry can change. Absent configuration
   * is a skip, not a failure: the effect completes having sent nothing, exactly
   * as `NotificationWebPushProvider` already treats it (NO_PROVIDER, not
   * retryable).
   */
  private skipUnconfigured(where: string, context: Record<string, unknown>): void {
    logger.warn(`web-push: ${where} skipped — VAPID keys are not configured`, context);
  }

  async sendToUser(
    orgId: string,
    userId: string,
    payload: PushPayload,
    effect?: { orgId: string; producerEventId: string; effectKey: string },
    membershipId?: number | null,
    preloadedSubscriptions?: readonly PushSubscriptionRow[],
  ): Promise<void> {
    if (!this.configured) {
      this.skipUnconfigured("sendToUser", { orgId, userId });
      return;
    }

    const subs =
      preloadedSubscriptions ??
      (await loadSubscriptionsForUser(this.db, orgId, userId, membershipId));

    if (subs.length === 0) return;

    const expiredEndpoints: string[] = [];

    const results = await Promise.allSettled(
      subs.map((sub) => {
        const send = () => webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
        ).then(() => undefined);
        if (!effect) return send();
        const endpointHash = createHash("sha256").update(sub.endpoint).digest("hex").slice(0, 24);
        return this.effects.execute({
          organizationId: effect.orgId,
          producerEventId: effect.producerEventId,
          effectKey: `${effect.effectKey}:subscription:${endpointHash}`,
          effectType: "chat.push.subscription",
          providerIdempotency: "STABLE_KEY_PROPAGATED",
        }, send).then(() => undefined);
      }),
    );

    const failures = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      const error = result.reason;
      if (error instanceof webpush.WebPushError && EXPIRED_STATUS.has(error.statusCode)) {
        const endpoint = subs[index]?.endpoint;
        if (endpoint) expiredEndpoints.push(endpoint);
        return [];
      }
      return [error];
    });

    await deleteExpiredSubscriptions(this.db, orgId, expiredEndpoints);

    if (failures.length > 0)
      throw new AggregateError(failures, `push delivery failed for ${failures.length} subscription(s)`);
  }

  async sendToChannelMembers(
    orgId: string,
    channelId: number,
    senderUserId: string,
    payload: PushPayload,
    idempotencyKey?: string,
  ): Promise<void> {
    if (!this.configured) {
      this.skipUnconfigured("sendToChannelMembers", { orgId, channelId });
      return;
    }

    const members = await this.db
      .select({
        userId: organizationMembers.userId,
        mutedUntil: chatChannelMembers.mutedUntil,
        notificationPreference: chatChannelMembers.notificationPreference,
      })
      .from(chatChannelMembers)
      .innerJoin(organizationMembers, eq(organizationMembers.id, chatChannelMembers.membershipId))
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          ne(organizationMembers.userId, senderUserId),
        ),
      );

    /**
     * `muted_until` and `notification_preference` are columns of the table this
     * query already joins, and neither was read: a member who muted the channel
     * until tomorrow, or set it to mentions-only, still got a device push for
     * every message. The sibling Ably path filters on both
     * (`chat-notifications.service.ts:74-81`).
     *
     * `DEFAULT` is deliberately left through. It means "use
     * `chat_org_settings.defaultNotificationPreference`", which lives behind
     * `ChatOrgSettingsService`; `ChatModule` imports `RealtimeModule`, so
     * realtime cannot read it back without a module cycle. Resolving it means
     * chat resolving the recipient set and passing it in. Until then a `DEFAULT`
     * member behaves exactly as before — the explicit opt-outs are what change.
     */
    const now = new Date();
    const recipients = members.filter(
      ({ mutedUntil, notificationPreference }) =>
        !(mutedUntil && mutedUntil > now) &&
        !PUSH_SUPPRESSING_PREFERENCES.has(notificationPreference),
    );

    if (recipients.length === 0) return;

    /**
     * Bounded, not truncated. The previous form was
     * `Promise.allSettled(members.map(...))`, so one message in a 5,000-member
     * channel opened 5,000 `sendToUser` calls at once — each its own
     * subscription SELECT, ledger write and HTTPS push — against a pool whose
     * `max` is 10-20. Capping the recipient SELECT instead would have silently
     * dropped members, turning a resource problem into a correctness one; the
     * window is what needs bounding, not the audience.
     *
     * Bounding the window left the read count alone: one `push_subscriptions`
     * SELECT still ran per recipient, which is the per-item database call
     * PRD-C145 names. The subscriptions for a whole page are read in ONE query
     * and handed to `sendToUser`, so the reads grow with pages rather than with
     * members — 5,000 recipients go from 5,000 SELECTs to 25.
     */
    const failures: unknown[] = [];
    for (let offset = 0; offset < recipients.length; offset += PUSH_SUBSCRIPTION_BATCH) {
      const page = recipients.slice(offset, offset + PUSH_SUBSCRIPTION_BATCH);
      const byUser = await loadSubscriptionsForPage(this.db, orgId, page.map((m) => m.userId));
      const results = await boundedMap(page, PUSH_FANOUT_CONCURRENCY, (m) =>
        this.sendToUser(
          orgId,
          m.userId,
          idempotencyKey ? { ...payload, idempotencyKey: `${idempotencyKey}:${m.userId}` } : payload,
          idempotencyKey ? { orgId, producerEventId: idempotencyKey, effectKey: `${idempotencyKey}:${m.userId}` } : undefined,
          null,
          byUser.get(m.userId) ?? [],
        ),
      );
      for (const result of results)
        if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, `push fan-out failed for ${failures.length} member(s)`);
  }

  private vapidSubject(): string {
    const appUrl = this.config.APP_URL.trim();
    if (appUrl.startsWith("https://")) return appUrl;

    const from = this.config.EMAIL_FROM_ADDRESS?.trim();
    if (from) {
      if (from.startsWith("mailto:")) return from;
      if (from.includes("@")) return `mailto:${from}`;
    }

    throw new Error("VAPID subject requires APP_URL (https) or EMAIL_FROM_ADDRESS to be set");
  }
}
