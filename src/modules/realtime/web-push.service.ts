import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import * as webpush from "web-push";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { chatChannelMembers, organizationMembers, pushSubscriptions } from "../../db/schema";
import type { PushPayload } from "./dto/realtime.schemas";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { ExternalEffectLedger } from "../../common/outbox/external-effect-ledger";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

const EXPIRED_STATUS = new Set([404, 410]);

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

  private subscriptionPredicate(userId: string, membershipId: number | null | undefined) {
    if (membershipId != null)
      return or(
        eq(pushSubscriptions.membershipId, membershipId),
        and(isNull(pushSubscriptions.membershipId), eq(pushSubscriptions.userId, userId)),
      );
    return eq(pushSubscriptions.userId, userId);
  }

  /**
   * `orgId` is a parameter rather than an implication.
   *
   * `push_subscriptions` is behind `tenant_isolation` and the lookup below
   * filters on the recipient alone (its membership, or its user for a row
   * written before memberships) — the organisation comes from the transaction's
   * tenant GUC and from nothing else. Taking it on trust from an ambient that
   * may not be there is what broke this: a caller that fires and forgets hands
   * on whatever transaction was open at the call site, and by the time the
   * lookup runs that transaction has committed. With no ambient at all the
   * accessor raises 42501; against a *closed* handle the query does not fail,
   * it never settles, so the `.catch` never runs and nothing is logged either
   * way. Named here, the scope can be reopened rather than inherited.
   */
  async sendToUser(
    orgId: string,
    userId: string,
    payload: PushPayload,
    effect?: { producerEventId: string; effectKey: string },
    membershipId?: number | null,
  ): Promise<void> {
    if (!this.configured) {
      if (effect) throw new Error("Web Push is not configured");
      return;
    }

    /**
     * Short and read-only on purpose: the sends below must not be made with a
     * database transaction held open. `runInTenantTransaction` reuses a live
     * ambient where there is one — the request and dispatch paths that await
     * this — and opens its own only when there is not.
     */
    const subs = await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .select({
            endpoint: pushSubscriptions.endpoint,
            p256dh: pushSubscriptions.p256dh,
            auth: pushSubscriptions.auth,
          })
          .from(pushSubscriptions)
          .where(this.subscriptionPredicate(userId, membershipId)),
      { orgId },
    );

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
          organizationId: orgId,
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

    /**
     * The reap is a write that happens *after* the sends, so it needs the
     * tenant scope to still be there — the half a fix that only covered the
     * lookup would leave silently broken.
     */
    if (expiredEndpoints.length > 0)
      await runInTenantTransaction(
        this.db,
        (tx) =>
          tx
            .delete(pushSubscriptions)
            .where(inArray(pushSubscriptions.endpoint, expiredEndpoints)),
        { orgId },
      );

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
      if (idempotencyKey) throw new Error("Web Push is not configured");
      return;
    }

    const members = await this.db
      .select({ userId: organizationMembers.userId })
      .from(chatChannelMembers)
      .innerJoin(organizationMembers, eq(organizationMembers.id, chatChannelMembers.membershipId))
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          ne(organizationMembers.userId, senderUserId),
        ),
      );

    if (members.length === 0) return;

    const results = await Promise.allSettled(
      members.map((m) => this.sendToUser(
        orgId,
        m.userId,
        idempotencyKey ? { ...payload, idempotencyKey: `${idempotencyKey}:${m.userId}` } : payload,
        idempotencyKey ? { producerEventId: idempotencyKey, effectKey: `${idempotencyKey}:${m.userId}` } : undefined,
      )),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
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
