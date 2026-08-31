import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { pushSubscriptions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { SubscribeInput } from "./dto/push.schemas";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";

@Injectable()
export class PushService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, "VAPID_PUBLIC_KEY">,
  ) {}

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

  async unsubscribe(endpoint: string, userId: string) {
    await this.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)));
    return { success: true };
  }

  getVapidPublicKey() {
    return { key: this.config.VAPID_PUBLIC_KEY ?? "" };
  }
}
