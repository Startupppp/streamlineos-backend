import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";
import { providerWebhookEvents } from "../../../db/schema/billing/provider-webhook-events";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

// RETRY means recorded but never finished, so the work must run again; PROCESSED is the only no-op.
export type ProviderEventClaim =
  | "RECORDED"
  | "RETRY"
  | "PROCESSED"
  | "FOREIGN"
  | "ERROR";

export interface ProviderEventKey {
  orgId: string;
  providerKey: string;
  providerEventId: string;
}

export class ProviderEventLedger {
  constructor(private readonly db: Db) {}

  // ON CONFLICT cannot tell a completed replay from a failed attempt; only processed_at can.
  async claim(
    key: ProviderEventKey,
    event: { eventType: string; rawBody: string },
  ): Promise<ProviderEventClaim> {
    const { orgId, providerKey, providerEventId } = key;
    try {
      return await runInNewTenantTransaction(this.db, orgId, async (tx) => {
        const inserted = await tx
          .insert(providerWebhookEvents)
          .values({
            orgId,
            provider: providerKey,
            providerEventId,
            eventType: event.eventType,
            rawPayload: JSON.parse(event.rawBody),
          })
          .onConflictDoNothing({
            target: [
              providerWebhookEvents.orgId,
              providerWebhookEvents.provider,
              providerWebhookEvents.providerEventId,
            ],
          })
          .returning({ id: providerWebhookEvents.id });
        if (inserted.length > 0) return "RECORDED";

        const [existing] = await tx
          .select({ processedAt: providerWebhookEvents.processedAt })
          .from(providerWebhookEvents)
          .where(this.matches(key))
          .limit(1);
        // With the composite (org_id, provider, provider_event_id) index a conflict is
        // always same-org, so this branch is dead in production. Retained so the handler
        // keeps its defensive 409 path and the existing test suite stays green.
        if (!existing) return "FOREIGN";
        return existing.processedAt === null ? "RETRY" : "PROCESSED";
      });
    } catch (error) {
      logger.error(`[billing:${providerKey}] failed to record provider event`, {
        error,
        providerEventId,
      });
      return "ERROR";
    }
  }

  /** Stamps the event processed inside the caller's transaction — never on its own. */
  acknowledge(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    key: ProviderEventKey,
  ) {
    return tx
      .update(providerWebhookEvents)
      .set({ processedAt: new Date() })
      .where(this.matches(key));
  }

  // The stuck-provisioning queue; the raw payload is withheld because it carries payer detail.
  async listUnprocessed(orgId: string) {
    const rows = await this.db
      .select({
        id: providerWebhookEvents.id,
        provider: providerWebhookEvents.provider,
        providerEventId: providerWebhookEvents.providerEventId,
        eventType: providerWebhookEvents.eventType,
        receivedAt: providerWebhookEvents.createdAt,
      })
      .from(providerWebhookEvents)
      .where(
        and(
          eq(providerWebhookEvents.orgId, orgId),
          isNull(providerWebhookEvents.processedAt),
        ),
      )
      .orderBy(asc(providerWebhookEvents.createdAt))
      .limit(100);

    return { events: rows, total: rows.length };
  }

  /**
   * Recorded but never finished, and old enough that the request that recorded it is gone.
   * `maxAgeMs` is the dead-letter boundary: past it the row is left for `listUnprocessed` and
   * an operator, so a permanently failing event cannot be retried forever.
   */
  listRedrivable(
    orgId: string,
    window: { minAgeMs: number; maxAgeMs: number; limit: number },
    now: Date,
  ) {
    return this.db
      .select({
        provider: providerWebhookEvents.provider,
        providerEventId: providerWebhookEvents.providerEventId,
        eventType: providerWebhookEvents.eventType,
        rawPayload: providerWebhookEvents.rawPayload,
      })
      .from(providerWebhookEvents)
      .where(
        and(
          eq(providerWebhookEvents.orgId, orgId),
          isNull(providerWebhookEvents.processedAt),
          lt(providerWebhookEvents.createdAt, new Date(now.getTime() - window.minAgeMs)),
          gt(providerWebhookEvents.createdAt, new Date(now.getTime() - window.maxAgeMs)),
        ),
      )
      .orderBy(asc(providerWebhookEvents.createdAt))
      .limit(window.limit);
  }

  private matches(key: ProviderEventKey) {
    return and(
      eq(providerWebhookEvents.orgId, key.orgId),
      eq(providerWebhookEvents.provider, key.providerKey),
      eq(providerWebhookEvents.providerEventId, key.providerEventId),
    );
  }
}
