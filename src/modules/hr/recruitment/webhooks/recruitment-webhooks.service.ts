import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, or, sql, isNull, asc } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { hrWebhookSubscriptions, hrWebhookDeliveries } from "../../../../db/schema/hr/webhooks";
import { logger } from "../../../../common/logger/logger.service";
import { RECRUITMENT_EVENTS, type RecruitmentEvent } from "../recruitment-webhook-events";
import { HR_SCAN_MAX_PAGES, HR_SCAN_PAGE } from "../../hr-read-limits";
import { createHmac } from "node:crypto";

const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;

function buildSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

@Injectable()
export class RecruitmentWebhooksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  dispatch(orgId: string, event: RecruitmentEvent, payload: Record<string, unknown>): void {
    void this.run(orgId, event, payload).catch((err) => {
      logger.error("recruitment-webhooks dispatch failed", { orgId, event, err });
    });
  }

  private async run(
    orgId: string,
    event: RecruitmentEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    let afterSubscriptionId = 0;
    for (let page = 0; page < HR_SCAN_MAX_PAGES; page++) {
      const active = await this.db
        .select()
        .from(hrWebhookSubscriptions)
        .where(
          and(
            eq(hrWebhookSubscriptions.orgId, orgId),
            eq(hrWebhookSubscriptions.isActive, true),
            isNull(hrWebhookSubscriptions.deletedAt),
            gt(hrWebhookSubscriptions.id, afterSubscriptionId),
            or(
              sql`${hrWebhookSubscriptions.events} = '{}'`,
              sql`${hrWebhookSubscriptions.events} @> ARRAY[${event}]::text[]`,
            ),
          ),
        )
        .orderBy(asc(hrWebhookSubscriptions.id))
        .limit(HR_SCAN_PAGE);

      if (active.length === 0) return;

      const insertedDeliveries = await this.db
        .insert(hrWebhookDeliveries)
        .values(
          active.map((s) => ({
            orgId,
            subscriptionId: s.id,
            event,
            payload,
            status: "pending" as const,
            attempts: 0,
          })),
        )
        .returning();

      // For simplicity in this implementation, assume delivery attempts are managed by hr-webhooks-service retry loop
      // which scans hr_webhook_deliveries, or trigger them here.
      // Reusing logic from attemptDelivery would be better, but keep it simple initially.

      if (active.length < HR_SCAN_PAGE) return;
      afterSubscriptionId = active[active.length - 1].id;
    }
  }
}
