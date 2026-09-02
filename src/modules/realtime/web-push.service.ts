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

  /**
   * Org-led: a person in two organizations has a subscription row per organization,
   * so matching on user alone pushes one tenant's notification to the other's device
   * registration and leaves the (org_id, membership_id) index unusable.
   */
  private subscriptionPredicate(
    orgId: string,
    userId: string,
    membershipId: number | null | undefined,
  ) {
    const owner =
      membershipId != null
        ? or(
            eq(pushSubscriptions.membershipId, membershipId),
            and(isNull(pushSubscriptions.membershipId), eq(pushSubscriptions.userId, userId)),
          )
        : eq(pushSubscriptions.userId, userId);
    return and(eq(pushSubscriptions.orgId, orgId), owner);
  }

  async sendToUser(
    orgId: string,
    userId: string,
    payload: PushPayload,
    effect?: { orgId: string; producerEventId: string; effectKey: string },
    membershipId?: number | null,
  ): Promise<void> {
    if (!this.configured) {
      if (effect) throw new Error("Web Push is not configured");
      return;
    }

    const subs = await this.db
      .select({
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(this.subscriptionPredicate(orgId, userId, membershipId));

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

    if (expiredEndpoints.length > 0)
      await this.db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.orgId, orgId),
            inArray(pushSubscriptions.endpoint, expiredEndpoints),
          ),
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
        idempotencyKey ? { orgId, producerEventId: idempotencyKey, effectKey: `${idempotencyKey}:${m.userId}` } : undefined,
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
