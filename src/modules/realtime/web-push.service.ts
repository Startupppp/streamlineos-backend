import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, ne } from "drizzle-orm";
import * as webpush from "web-push";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { chatChannelMembers, pushSubscriptions } from "../../db/schema";
import type { PushPayload } from "./dto/realtime.schemas";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";

const EXPIRED_STATUS = new Set([404, 410]);

@Injectable()
export class WebPushService {
  private readonly publicKey: string | undefined;
  private readonly privateKey: string | undefined;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.publicKey = this.config.VAPID_PUBLIC_KEY?.trim();
    this.privateKey = this.config.VAPID_PRIVATE_KEY?.trim();
    if (this.publicKey && this.privateKey)
      webpush.setVapidDetails(this.vapidSubject(), this.publicKey, this.privateKey);
  }

  get configured(): boolean {
    return Boolean(this.publicKey && this.privateKey);
  }

  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    if (!this.configured) return;

    const subs = await this.db
      .select({
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));

    if (subs.length === 0) return;

    const expiredEndpoints: string[] = [];

    const results = await Promise.allSettled(
      subs.map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
        ),
      ),
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
        .where(inArray(pushSubscriptions.endpoint, expiredEndpoints));

    if (failures.length > 0)
      throw new AggregateError(failures, `push delivery failed for ${failures.length} subscription(s)`);
  }

  async sendToChannelMembers(
    orgId: string,
    channelId: number,
    senderUserId: string,
    payload: PushPayload,
  ): Promise<void> {
    if (!this.configured) return;

    const members = await this.db
      .select({ userId: chatChannelMembers.userId })
      .from(chatChannelMembers)
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          ne(chatChannelMembers.userId, senderUserId),
        ),
      );

    if (members.length === 0) return;

    const results = await Promise.allSettled(members.map((m) => this.sendToUser(m.userId, payload)));
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
