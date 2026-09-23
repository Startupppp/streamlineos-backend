import { Injectable, Inject, Logger } from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { eq, and, sql, or } from "drizzle-orm";
import { hrWebhookSubscriptions, hrWebhookDeliveries } from "../../../../db/schema/hr/webhooks";
import { RecruitmentEvent } from "../recruitment-webhook-events";

export interface WebhookEmitOptions {
  readonly dedupeKey?: string;
}

@Injectable()
export class RecruitmentWebhookEmitter {
  private readonly logger = new Logger(RecruitmentWebhookEmitter.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async emit(
    orgId: string,
    event: RecruitmentEvent,
    payload: Record<string, unknown>,
    _options: WebhookEmitOptions = {},
  ): Promise<{ enqueued: number }> {
    const matching = await this.db
      .select({ id: hrWebhookSubscriptions.id })
      .from(hrWebhookSubscriptions)
      .where(
        and(
          eq(hrWebhookSubscriptions.orgId, orgId),
          eq(hrWebhookSubscriptions.isActive, true),
          sql`${hrWebhookSubscriptions.events} @> ARRAY[${event}]::text[]`,
        ),
      );

    if (matching.length === 0) return { enqueued: 0 };

    const inserted = await this.db
      .insert(hrWebhookDeliveries)
      .values(
        matching.map((subscription) => ({
          orgId,
          subscriptionId: subscription.id,
          event,
          payload,
          status: "pending" as const,
          attempts: 0,
        })),
      )
      .returning({ id: hrWebhookDeliveries.id });

    return { enqueued: inserted.length };
  }
}
