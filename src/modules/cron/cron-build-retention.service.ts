import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, lt, ne } from "drizzle-orm";
import { webhookDeliveries } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";

const PRUNE_BATCH_SIZE = 500;
const WEBHOOK_DELIVERY_RETENTION_DAYS = 90;

@Injectable()
export class CronBuildRetentionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async pruneWebhookDeliveries(): Promise<{ webhookDeliveriesPruned: number }> {
    const cutoff = new Date(
      Date.now() - WEBHOOK_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    let total = 0;

    await forEachOrg(this.db, "prune-webhook-deliveries", async (tx, orgId) => {
      for (;;) {
        const rows = await tx
          .select({ id: webhookDeliveries.id })
          .from(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.orgId, orgId),
              lt(webhookDeliveries.deliveredAt, cutoff),
              ne(webhookDeliveries.status, "pending"),
            ),
          )
          .limit(PRUNE_BATCH_SIZE);
        if (rows.length === 0) break;

        await tx.delete(webhookDeliveries).where(
          inArray(
            webhookDeliveries.id,
            rows.map((r) => r.id),
          ),
        );
        total += rows.length;
        if (rows.length < PRUNE_BATCH_SIZE) break;
      }
    });

    return { webhookDeliveriesPruned: total };
  }
}
