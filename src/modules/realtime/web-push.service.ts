import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, ne } from "drizzle-orm";
import * as webpush from "web-push";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { chatChannelMembers, pushSubscriptions } from "../../db/schema";
import type { PushPayload } from "./dto/realtime.schemas";

const DEFAULT_VAPID_SUBJECT = "https://streamlineos.app";
const EXPIRED_STATUS = new Set([404, 410]);

@Injectable()
export class WebPushService {
  private readonly publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  private readonly privateKey = process.env.VAPID_PRIVATE_KEY?.trim();

  constructor(@Inject(DRIZZLE) private readonly db: Db) {
    if (this.publicKey && this.privateKey) {
      webpush.setVapidDetails(this.vapidSubject(), this.publicKey, this.privateKey);
    }
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

    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
          );
        } catch (error) {
          if (error instanceof webpush.WebPushError && EXPIRED_STATUS.has(error.statusCode)) {
            expiredEndpoints.push(sub.endpoint);
          }
        }
      }),
    );

    if (expiredEndpoints.length > 0) {
      await this.db
        .delete(pushSubscriptions)
        .where(inArray(pushSubscriptions.endpoint, expiredEndpoints));
    }
  }

  async sendToChannelMembers(
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
          eq(chatChannelMembers.channelId, channelId),
          ne(chatChannelMembers.userId, senderUserId),
        ),
      );

    if (members.length === 0) return;

    await Promise.allSettled(members.map((m) => this.sendToUser(m.userId, payload)));
  }

  private vapidSubject(): string {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
    if (appUrl?.startsWith("https://")) return appUrl;

    const from = process.env.EMAIL_FROM_ADDRESS?.trim();
    if (from) {
      if (from.startsWith("mailto:")) return from;
      if (from.includes("@")) return `mailto:${from}`;
    }

    return DEFAULT_VAPID_SUBJECT;
  }
}
