import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { pushSubscriptions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { SubscribeInput } from "./dto/push.schemas";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import {
  PUSH_ENDPOINT_CONFLICT,
  pushSubscriptionOwnership,
} from "./push-subscription-ownership";

@Injectable()
export class PushService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, "VAPID_PUBLIC_KEY">,
  ) {}

  /**
   * Registers a browser against the caller, taking the registration over from
   * whoever held it before.
   *
   * A push endpoint is the natural key of ONE browser, and `endpoint` carries a
   * global unique constraint that says so. The person sitting at that browser is
   * not part of that key, so a subscribe from a browser someone else registered
   * has to move the row's ownership rather than patch its keys. The head form set
   * `p256dh` and `auth` only, which left the row naming the first subscriber:
   * `WebPushService.sendToUser` then delivered THEIR notifications to whoever now
   * holds the browser, and `unsubscribe(endpoint, newUser)` matched no row so the
   * new holder could not stop it. Measured on a real database, both directions.
   *
   * The claim comes first because RLS makes the upsert alone insufficient. The
   * table is `USING (org_id = app.current_org_id())`, so a row for this endpoint
   * held by ANOTHER tenant is invisible — `ON CONFLICT DO UPDATE` cannot see it to
   * update it and raises 42501 ("new row violates row-level security policy
   * (USING expression)"), and a `DELETE ... WHERE endpoint = $1` cannot see it to
   * delete it either. `app.claim_push_endpoint` (migration 1061) is SECURITY
   * DEFINER for exactly that one delete, and touches nothing in the caller's own
   * tenant: that row is re-owned below, under live RLS.
   */
  async subscribe(orgId: string, userId: string, input: SubscribeInput) {
    await this.db.execute(sql`SELECT app.claim_push_endpoint(${input.endpoint})`);

    const owner = pushSubscriptionOwnership({ orgId, userId, ...input });
    await this.db
      .insert(pushSubscriptions)
      .values({ ...owner, endpoint: input.endpoint })
      .onConflictDoUpdate({ ...PUSH_ENDPOINT_CONFLICT, set: owner });
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
