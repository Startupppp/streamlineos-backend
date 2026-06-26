import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { pushSubscriptions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { SubscribeInput } from "./dto/push.schemas";

@Injectable()
export class PushService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async subscribe(orgId: string, userId: string, input: SubscribeInput) {
    await this.db
      .insert(pushSubscriptions)
      .values({ userId, orgId, ...input })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { p256dh: input.p256dh, auth: input.auth },
      });
    return { success: true };
  }

  async unsubscribe(endpoint: string) {
    await this.db
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint));
    return { success: true };
  }

  getVapidPublicKey() {
    return { key: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "" };
  }
}
