import { and, asc, eq, inArray, isNull, or, lte } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { forEachOrg } from "../../../../common/tenant";
import { invChannelWebhookDeliveries } from "../../../../db/schema";
import {
  ChannelAdapterRegistry,
  ChannelEndpointRejected,
  ChannelTimeoutError,
  CHANNEL_CALL_TIMEOUT_MS,
  assertChannelEndpointAllowed,
  planChannelAttempt,
  withChannelTimeout,
  type ChannelSnapshotResult,
} from "../channel-adapter";
import {
  loadChannelContext,
  DELIVERY_LEASE_MS,
  DRAIN_BATCH_SIZE,
  type ChannelContext,
  type DrainableDelivery,
  type SnapshotSweepResult,
} from "./channel-snapshot-context";
import { recordDifferences } from "./channel-snapshot-diff";

/**
 * The drain worker: claim pending deliveries, refetch, record, retry.
 *
 * `process` is spelled `processDelivery` here because at module scope the
 * original name would shadow Node's `process` global.
 */
export interface SnapshotWorkerDeps {
  readonly db: Db;
  readonly adapters: ChannelAdapterRegistry;
}

/**
 * One sweep of pending deliveries.
 *
 * Claim and fetch are deliberately in separate transactions. The claim runs
 * inside a tenant transaction per organisation (`forEachOrg` is the only way a
 * background sweep gets a tenant GUC at all); the adapter call runs outside
 * any transaction, because an HTTP call to a marketplace inside one holds a
 * pooled Postgres connection for the length of somebody else's outage.
 */
export async function drainPending(deps: SnapshotWorkerDeps): Promise<SnapshotSweepResult> {
  const result: SnapshotSweepResult = {
    claimed: 0,
    refetched: 0,
    differencesRecorded: 0,
    retried: 0,
    dead: 0,
  };

  const claimed = await claim(deps, result);
  for (const delivery of claimed) {
    await processDelivery(deps, delivery, result);
  }
  return result;
}

async function claim(deps: SnapshotWorkerDeps, result: SnapshotSweepResult): Promise<DrainableDelivery[]> {
  const now = new Date();
  const lease = new Date(now.getTime() + DELIVERY_LEASE_MS);
  const claimed: DrainableDelivery[] = [];

  await forEachOrg(deps.db, "inventory-channel-snapshot", async (tx, orgId) => {
    const due = await tx
      .select({
        id: invChannelWebhookDeliveries.id,
        channelId: invChannelWebhookDeliveries.channelId,
        attemptCount: invChannelWebhookDeliveries.attemptCount,
      })
      .from(invChannelWebhookDeliveries)
      .where(
        and(
          eq(invChannelWebhookDeliveries.orgId, orgId),
          or(
            eq(invChannelWebhookDeliveries.status, "PENDING"),
            eq(invChannelWebhookDeliveries.status, "FAILED"),
          ),
          or(
            isNull(invChannelWebhookDeliveries.leaseExpiresAt),
            lte(invChannelWebhookDeliveries.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(asc(invChannelWebhookDeliveries.receivedAt))
      .limit(DRAIN_BATCH_SIZE);

    if (due.length === 0) return;

    await tx
      .update(invChannelWebhookDeliveries)
      .set({ leaseExpiresAt: lease, updatedAt: now })
      .where(
        and(
          eq(invChannelWebhookDeliveries.orgId, orgId),
          inArray(
            invChannelWebhookDeliveries.id,
            due.map((d) => d.id),
          ),
        ),
      );

    for (const row of due) {
      claimed.push({ orgId, id: row.id, channelId: row.channelId, attemptCount: row.attemptCount });
    }
    result.claimed += due.length;
  });

  return claimed;
}

async function processDelivery(
  deps: SnapshotWorkerDeps,
  delivery: DrainableDelivery,
  result: SnapshotSweepResult,
): Promise<void> {
  const context = await runInNewTenantTransaction(deps.db, delivery.orgId, (tx) =>
    loadChannelContext(tx, delivery.orgId, delivery.channelId),
  );

  const snapshot = context
    ? await fetchSnapshot(deps, context)
    : ({
        ok: false as const,
        code: "CHANNEL_GONE",
        message: "The channel this delivery names no longer exists",
        terminal: true,
      } satisfies ChannelSnapshotResult);

  if (!snapshot.ok) {
    await recordFailure(deps, delivery, snapshot.message, snapshot.terminal, result);
    return;
  }

  const recorded = await runInNewTenantTransaction(deps.db, delivery.orgId, (tx) =>
    recordDifferences(tx, delivery, context!, snapshot),
  );
  result.differencesRecorded += recorded;
  result.refetched += 1;

  // A partial snapshot is not a complete one. The rows that did come back are
  // facts and are recorded, but the delivery stays retryable so the SKUs the
  // channel refused on are asked about again — marking it PROCESSED here would
  // quietly declare a reconciliation finished that never covered half its
  // catalogue.
  if (!snapshot.complete || snapshot.failures.length > 0) {
    await recordFailure(deps, 
      delivery,
      `partial snapshot: ${snapshot.failures.length} sku(s) unanswered`,
      false,
      result,
    );
    return;
  }

  await runInNewTenantTransaction(deps.db, delivery.orgId, async (tx) => {
    await tx
      .update(invChannelWebhookDeliveries)
      .set({
        status: "PROCESSED",
        processedAt: new Date(),
        attemptCount: delivery.attemptCount + 1,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(invChannelWebhookDeliveries.orgId, delivery.orgId),
          eq(invChannelWebhookDeliveries.id, delivery.id),
        ),
      );
  });
}

async function recordFailure(
  deps: SnapshotWorkerDeps,
  delivery: DrainableDelivery,
  message: string,
  terminal: boolean,
  result: SnapshotSweepResult,
): Promise<void> {
  const plan = planChannelAttempt({ attempts: delivery.attemptCount, ok: false, terminal });
  if (plan.deadLettered) result.dead += 1;
  else result.retried += 1;

  await runInNewTenantTransaction(deps.db, delivery.orgId, async (tx) => {
    await tx
      .update(invChannelWebhookDeliveries)
      .set({
        status: plan.deadLettered ? "DEAD" : "FAILED",
        attemptCount: plan.attempts,
        lastError: message.slice(0, 500),
        // Released rather than extended: the ladder decides when the next
        // attempt happens, and holding a lease past that would make the row
        // invisible to the sweep that is meant to retry it.
        leaseExpiresAt: plan.retryInMs === null ? null : new Date(Date.now() + plan.retryInMs),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(invChannelWebhookDeliveries.orgId, delivery.orgId),
          eq(invChannelWebhookDeliveries.id, delivery.id),
        ),
      );
  });
}

/**
 * One adapter call, guarded and bounded.
 *
 * The store endpoint is tenant-supplied, so it goes through the shared SSRF
 * guard before any adapter sees it — and the rejection is a *failure result*,
 * not a throw, so a misconfigured store URL retries and dead-letters like any
 * other bad channel rather than crashing the sweep for every other tenant.
 */
async function fetchSnapshot(deps: SnapshotWorkerDeps, context: ChannelContext): Promise<ChannelSnapshotResult> {
  const adapter = deps.adapters.forChannelType(context.channelType);
  if (!adapter.canFetch) {
    return {
      ok: false,
      code: "NO_ADAPTER",
      message: `No adapter can fetch for channel type ${context.channelType}; reconcile manually`,
      terminal: true,
    };
  }

  try {
    if (context.storeUrl) await assertChannelEndpointAllowed(context.storeUrl);
    return await withChannelTimeout(
      () =>
        adapter.fetchSnapshot({
          channelType: context.channelType,
          storeUrl: context.storeUrl,
          skus: [...context.skuToVariant.keys()],
          settings: context.settings,
        }),

      CHANNEL_CALL_TIMEOUT_MS,
    );
  } catch (error: unknown) {
    if (error instanceof ChannelEndpointRejected) {
      return { ok: false, code: "ENDPOINT_BLOCKED", message: error.message, terminal: true };
    }
    if (error instanceof ChannelTimeoutError) {
      return { ok: false, code: "TIMEOUT", message: error.message, terminal: false };
    }
    return {
      ok: false,
      code: "ADAPTER_ERROR",
      message: error instanceof Error ? error.message : String(error),
      terminal: false,
    };
  }
}
