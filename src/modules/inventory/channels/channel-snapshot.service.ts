import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, or, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import {
  runInNewTenantTransaction,
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import { forEachOrg } from "../../../common/tenant";
import {
  invChannels,
  invChannelSnapshotDiffs,
  invChannelStockPublications,
  invChannelWebhookDeliveries,
  invLocations,
  invProductVariants,
} from "../../../db/schema";
import { availableQtySumSql } from "../stock-engine/available-sql";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import {
  ChannelAdapterRegistry,
  ChannelEndpointRejected,
  ChannelTimeoutError,
  CHANNEL_CALL_TIMEOUT_MS,
  assertChannelEndpointAllowed,
  planChannelAttempt,
  verifyChannelDelivery,
  withChannelTimeout,
  type ChannelDeliveryRejection,
  type ChannelSnapshotResult,
} from "./channel-adapter";
import { planSnapshotDifferences } from "./snapshot-difference";
import type {
  ListSnapshotDiffsQueryInput,
  ResolveSnapshotDiffInput,
} from "./dto/channel-snapshot.schemas";

/**
 * E6 — snapshot → refetch → idempotent command.
 *
 * ## The three things this file exists to keep true
 *
 * 1. **A duplicate delivery does nothing twice.** `receiveDelivery` inserts on a
 *    unique `(org, channel, provider_delivery_id)` and reports whether the row
 *    was new. A channel replaying a delivery — which every marketplace does,
 *    because their delivery guarantee is at-least-once — enqueues no second
 *    refetch, so nothing downstream runs twice.
 *
 * 2. **A snapshot cannot drive a `quantity_change`.** The refetch path writes
 *    `inv_channel_snapshot_diffs` and stops. Posting is a separate act by a
 *    named operator through `StockEngineService`, permitted only where the
 *    channel's policy says so. Nothing in the delivery or drain path can reach
 *    a movement.
 *
 * 3. **"No answer" never reads as "zero".** An adapter that could not list
 *    everything says `complete: false`, and this service never manufactures a
 *    difference for a SKU the channel did not mention. Without that rule, one
 *    200-with-an-error-body from a marketplace produces "channel says 0" for
 *    every SKU we publish — and under `ALLOW_ADJUSTMENT` that is a one-request
 *    path to zeroing a warehouse.
 *
 * ## Why the delivery row is the queue
 *
 * backend/CLAUDE.md §4: a side effect fired after the request must not borrow
 * the request's transaction. Refetching inside the webhook handler would also
 * hold a pooled connection open for as long as a marketplace felt like taking,
 * inside a tenant transaction, while a channel waited on our acknowledgement and
 * retried. So the receiver does exactly one thing — durably record what arrived —
 * and `ChannelSnapshotWorker` does the fetching, outside any request, on the
 * ladder in `channel-adapter.ts`.
 */

/** How long a claimed delivery stays claimed if the drain dies mid-flight. */
const DELIVERY_LEASE_MS = 120_000;

/** Deliveries drained per organisation per sweep. */
const DRAIN_BATCH_SIZE = 25;

export type ReceiveOutcome =
  | { readonly accepted: true; readonly duplicate: boolean; readonly deliveryId: number }
  | { readonly accepted: false; readonly reason: ChannelDeliveryRejection | "unknown-channel" };

export interface SnapshotSweepResult {
  claimed: number;
  refetched: number;
  differencesRecorded: number;
  retried: number;
  dead: number;
}

interface DrainableDelivery {
  readonly orgId: string;
  readonly id: number;
  readonly channelId: number;
  readonly attemptCount: number;
}

@Injectable()
export class ChannelSnapshotService {
  private readonly logger = new Logger(ChannelSnapshotService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly adapters: ChannelAdapterRegistry,
    private readonly stockEngine: StockEngineService,
    private readonly audit: InventoryAuditService,
  ) {}

  /* ---------------------------------------------------------------- *
   * Inbound
   * ---------------------------------------------------------------- */

  /**
   * The signing secret for a channel type.
   *
   * Deployment configuration, never a tenant column: a store's shared secret is
   * a provider credential, and root CLAUDE.md §5 keeps provider credentials out
   * of our database. A per-store secret — which WooCommerce genuinely has —
   * belongs on the Composio connected account, alongside the token that would
   * let us call back.
   */
  private secretFor(channelType: string): string | null {
    if (channelType === "SHOPIFY") return this.config.INV_CHANNEL_WEBHOOK_SECRET_SHOPIFY ?? null;
    if (channelType === "WOOCOMMERCE") return this.config.INV_CHANNEL_WEBHOOK_SECRET_WOOCOMMERCE ?? null;
    return this.config.INV_CHANNEL_WEBHOOK_SECRET_DEFAULT ?? null;
  }

  /**
   * Verify one inbound delivery, record it, and acknowledge.
   *
   * The tenant is resolved through `app.resolve_inv_channel_org_id`, a
   * `SECURITY DEFINER` function that returns the org id and nothing else. It has
   * to be: the route is `@Public()`, so no tenant GUC is set, and `inv_channels`
   * is behind RLS — the handler literally cannot read the row that would tell it
   * which tenant to open a transaction for. Widening the channel policy instead
   * would expose `settings` to every id-only query forever.
   *
   * Order matters. The tenant lookup happens first because verification needs
   * the channel's type to know which header scheme to read; the *signature* is
   * still what authorises anything, and an unverified delivery is recorded
   * nowhere. A caller who guesses a channel id and cannot sign gets nothing but
   * a rejection.
   */
  async receiveDelivery(input: {
    readonly channelId: number;
    readonly rawBody: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }): Promise<ReceiveOutcome> {
    const orgRows = await this.db.execute<{ org_id: string | null }>(
      sql`SELECT app.resolve_inv_channel_org_id(${input.channelId}) AS org_id`,
    );
    const orgId = orgRows[0]?.org_id ? String(orgRows[0].org_id) : null;
    if (!orgId) return { accepted: false, reason: "unknown-channel" };

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const channel = await tx.query.invChannels.findFirst({
          where: and(eq(invChannels.orgId, orgId), eq(invChannels.id, input.channelId)),
          columns: { id: true, channelType: true, status: true },
        });
        if (!channel) return { accepted: false as const, reason: "unknown-channel" as const };

        const verified = verifyChannelDelivery({
          channelType: channel.channelType,
          secret: this.secretFor(channel.channelType),
          rawBody: input.rawBody,
          headers: input.headers,
        });
        if (!verified.valid) {
          this.logger.warn(
            `channel ${input.channelId} delivery rejected: ${verified.reason}`,
          );
          return { accepted: false as const, reason: verified.reason };
        }

        // The body itself is never stored. A marketplace payload carries a
        // customer's name and address, and this row answers "have we handled
        // delivery X", not "what did the customer order".
        const payloadDigest = createHash("sha256").update(input.rawBody, "utf8").digest("hex");

        const inserted = await tx
          .insert(invChannelWebhookDeliveries)
          .values({
            orgId,
            channelId: input.channelId,
            providerDeliveryId: verified.deliveryId,
            topic: verified.topic,
            externalRef: this.externalRefOf(input.rawBody),
            status: "PENDING",
            payloadDigest,
            deliveryMetadata: this.safeMetadata(input.headers),
          })
          .onConflictDoNothing({
            target: [
              invChannelWebhookDeliveries.orgId,
              invChannelWebhookDeliveries.channelId,
              invChannelWebhookDeliveries.providerDeliveryId,
            ],
          })
          .returning({ id: invChannelWebhookDeliveries.id });

        if (inserted.length > 0) {
          return { accepted: true as const, duplicate: false, deliveryId: inserted[0]!.id };
        }

        // The duplicate branch. Deliberately not an error: a marketplace
        // retrying a delivery it already sent has done nothing wrong, and 4xx
        // would make it retry harder. It gets the same acknowledgement, and
        // nothing is enqueued.
        const existing = await tx
          .select({ id: invChannelWebhookDeliveries.id })
          .from(invChannelWebhookDeliveries)
          .where(
            and(
              eq(invChannelWebhookDeliveries.orgId, orgId),
              eq(invChannelWebhookDeliveries.channelId, input.channelId),
              eq(invChannelWebhookDeliveries.providerDeliveryId, verified.deliveryId),
            ),
          )
          .limit(1);
        return { accepted: true as const, duplicate: true, deliveryId: existing[0]?.id ?? 0 };
      },
      { orgId },
    );
  }

  /** Only headers that are safe to keep, so a signature never lands in a row. */
  private safeMetadata(
    headers: Readonly<Record<string, string | undefined>>,
  ): Record<string, string> {
    const keep = ["x-shopify-topic", "x-shopify-shop-domain", "x-wc-webhook-topic", "x-wc-webhook-source", "x-marketplace-topic", "user-agent"];
    const out: Record<string, string> = {};
    for (const key of keep) {
      const value = headers[key];
      if (value) out[key] = value.slice(0, 200);
    }
    return out;
  }

  /**
   * The SKU a delivery names, when it names one.
   *
   * Best-effort and never load-bearing: it is a hint for the operator reading
   * the delivery list, and the refetch asks the channel about every SKU we
   * publish regardless. Parsing failure is not an error, because a body we
   * cannot read is still a delivery we must record — the alternative is
   * dropping the notification because its shape surprised us.
   */
  private externalRefOf(rawBody: string): string | null {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (parsed !== null && typeof parsed === "object") {
        const sku = (parsed as Record<string, unknown>).sku;
        if (typeof sku === "string" && sku.length > 0) return sku.slice(0, 200);
      }
    } catch {
      return null;
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Drain
   * ---------------------------------------------------------------- */

  /**
   * One sweep of pending deliveries.
   *
   * Claim and fetch are deliberately in separate transactions. The claim runs
   * inside a tenant transaction per organisation (`forEachOrg` is the only way a
   * background sweep gets a tenant GUC at all); the adapter call runs outside
   * any transaction, because an HTTP call to a marketplace inside one holds a
   * pooled Postgres connection for the length of somebody else's outage.
   */
  async drainPending(): Promise<SnapshotSweepResult> {
    const result: SnapshotSweepResult = {
      claimed: 0,
      refetched: 0,
      differencesRecorded: 0,
      retried: 0,
      dead: 0,
    };

    const claimed = await this.claim(result);
    for (const delivery of claimed) {
      await this.process(delivery, result);
    }
    return result;
  }

  private async claim(result: SnapshotSweepResult): Promise<DrainableDelivery[]> {
    const now = new Date();
    const lease = new Date(now.getTime() + DELIVERY_LEASE_MS);
    const claimed: DrainableDelivery[] = [];

    await forEachOrg(this.db, "inventory-channel-snapshot", async (tx, orgId) => {
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

  private async process(
    delivery: DrainableDelivery,
    result: SnapshotSweepResult,
  ): Promise<void> {
    const context = await runInNewTenantTransaction(this.db, delivery.orgId, (tx) =>
      this.loadChannelContext(tx, delivery.orgId, delivery.channelId),
    );

    const snapshot = context
      ? await this.fetchSnapshot(context)
      : ({
          ok: false as const,
          code: "CHANNEL_GONE",
          message: "The channel this delivery names no longer exists",
          terminal: true,
        } satisfies ChannelSnapshotResult);

    if (!snapshot.ok) {
      await this.recordFailure(delivery, snapshot.message, snapshot.terminal, result);
      return;
    }

    const recorded = await runInNewTenantTransaction(this.db, delivery.orgId, (tx) =>
      this.recordDifferences(tx, delivery, context!, snapshot),
    );
    result.differencesRecorded += recorded;
    result.refetched += 1;

    // A partial snapshot is not a complete one. The rows that did come back are
    // facts and are recorded, but the delivery stays retryable so the SKUs the
    // channel refused on are asked about again — marking it PROCESSED here would
    // quietly declare a reconciliation finished that never covered half its
    // catalogue.
    if (!snapshot.complete || snapshot.failures.length > 0) {
      await this.recordFailure(
        delivery,
        `partial snapshot: ${snapshot.failures.length} sku(s) unanswered`,
        false,
        result,
      );
      return;
    }

    await runInNewTenantTransaction(this.db, delivery.orgId, async (tx) => {
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

  private async recordFailure(
    delivery: DrainableDelivery,
    message: string,
    terminal: boolean,
    result: SnapshotSweepResult,
  ): Promise<void> {
    const plan = planChannelAttempt({ attempts: delivery.attemptCount, ok: false, terminal });
    if (plan.deadLettered) result.dead += 1;
    else result.retried += 1;

    await runInNewTenantTransaction(this.db, delivery.orgId, async (tx) => {
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

  /** Everything about a channel the refetch needs, read once inside a tenant tx. */
  private async loadChannelContext(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    channelId: number,
  ): Promise<ChannelContext | null> {
    const channel = await tx.query.invChannels.findFirst({
      where: and(eq(invChannels.orgId, orgId), eq(invChannels.id, channelId)),
    });
    if (!channel) return null;

    // What we publish to this channel is what we ask it about. A channel we have
    // never published to has nothing to reconcile, and asking a marketplace for
    // its whole catalogue to compare against nothing is how a sweep becomes an
    // outage.
    const published = await tx
      .select({ sku: invProductVariants.sku, productVariantId: invChannelStockPublications.productVariantId })
      .from(invChannelStockPublications)
      .innerJoin(
        invProductVariants,
        and(
          eq(invProductVariants.id, invChannelStockPublications.productVariantId),
          eq(invProductVariants.orgId, invChannelStockPublications.orgId),
        ),
      )
      .where(
        and(
          eq(invChannelStockPublications.orgId, orgId),
          eq(invChannelStockPublications.channelId, channelId),
        ),
      );

    const settings = (channel.settings ?? {}) as Record<string, unknown>;
    const storeUrl = typeof settings.storeUrl === "string" ? settings.storeUrl : null;

    return {
      orgId,
      channelId,
      channelType: channel.channelType,
      storeUrl,
      warehouseIds: (channel.warehouseIds ?? []) as number[],
      skuToVariant: new Map(published.map((p) => [p.sku, p.productVariantId])),
    };
  }

  /**
   * One adapter call, guarded and bounded.
   *
   * The store endpoint is tenant-supplied, so it goes through the shared SSRF
   * guard before any adapter sees it — and the rejection is a *failure result*,
   * not a throw, so a misconfigured store URL retries and dead-letters like any
   * other bad channel rather than crashing the sweep for every other tenant.
   */
  private async fetchSnapshot(context: ChannelContext): Promise<ChannelSnapshotResult> {
    const adapter = this.adapters.forChannelType(context.channelType);
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

  /**
   * Turn a snapshot into differences, and nothing else.
   *
   * Only SKUs the channel actually mentioned produce a row. A SKU it did not
   * mention has told us nothing — and the difference between "told us nothing"
   * and "told us zero" is the difference between a reconciliation report and a
   * warehouse being emptied by a bad response body.
   */
  private async recordDifferences(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    delivery: DrainableDelivery | null,
    context: ChannelContext,
    snapshot: Extract<ChannelSnapshotResult, { ok: true }>,
  ): Promise<number> {
    if (snapshot.items.length === 0) return 0;

    const variantIds = snapshot.items
      .map((item) => context.skuToVariant.get(item.sku))
      .filter((id): id is number => typeof id === "number");

    const internalAvailability = await this.internalAvailability(tx, context, variantIds);

    // The rule lives in `planSnapshotDifferences`, not here: only SKUs the
    // channel actually mentioned produce a row, and a matched SKU that agrees
    // produces none. Keeping it pure is what lets a unit test prove that a 200
    // carrying an error body cannot manufacture "the channel says 0" for every
    // SKU we publish.
    const planned = planSnapshotDifferences({
      snapshot,
      skuToVariant: context.skuToVariant,
      internalAvailability,
    });

    for (const difference of planned) {
      await tx
        .insert(invChannelSnapshotDiffs)
        .values({
          orgId: context.orgId,
          channelId: context.channelId,
          deliveryId: delivery?.id ?? null,
          productVariantId: difference.productVariantId,
          externalSku: difference.externalSku,
          channelQty: difference.channelQty,
          internalQty: difference.internalQty,
          difference: difference.difference,
          status: "OPEN",
          snapshotAt: snapshot.capturedAt,
        })
        .onConflictDoUpdate({
          // The partial unique index on OPEN rows. A later refetch finding the
          // same disagreement updates it rather than adding to a pile, so an
          // operator sees one row per SKU rather than one per delivery.
          target: [
            invChannelSnapshotDiffs.orgId,
            invChannelSnapshotDiffs.channelId,
            invChannelSnapshotDiffs.externalSku,
          ],
          targetWhere: sql`status = 'OPEN'`,
          set: {
            deliveryId: delivery?.id ?? null,
            productVariantId: difference.productVariantId,
            channelQty: difference.channelQty,
            internalQty: difference.internalQty,
            difference: difference.difference,
            snapshotAt: snapshot.capturedAt,
            updatedAt: new Date(),
          },
        });
    }

    return planned.length;
  }

  /**
   * What we believe is sellable on this channel, by variant.
   *
   * The same expression the publisher uses — `availableQtySumSql` — and
   * deliberately not a private copy. A reconciliation that compared the channel
   * against a *different* definition of availability than the one we published
   * would report a difference on every SKU and be right about none of them.
   */
  private async internalAvailability(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    context: ChannelContext,
    variantIds: readonly number[],
  ): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (variantIds.length === 0 || context.warehouseIds.length === 0) return out;

    const locations = await tx
      .select({ id: invLocations.id })
      .from(invLocations)
      .where(
        and(
          eq(invLocations.orgId, context.orgId),
          inArray(invLocations.warehouseId, [...context.warehouseIds]),
        ),
      );
    if (locations.length === 0) return out;

    const rows = await tx.execute<{ product_variant_id: number; available: string }>(sql`
      SELECT inv_stock_levels.product_variant_id,
             ${availableQtySumSql("inv_stock_levels")}::text AS available
        FROM inv_stock_levels
       WHERE inv_stock_levels.org_id = ${context.orgId}
         AND inv_stock_levels.location_id IN (${sql.join(
           locations.map((l) => sql`${l.id}`),
           sql`, `,
         )})
         AND inv_stock_levels.product_variant_id IN (${sql.join(
           variantIds.map((id) => sql`${id}`),
           sql`, `,
         )})
       GROUP BY inv_stock_levels.product_variant_id
    `);

    for (const row of rows) out.set(Number(row.product_variant_id), String(row.available));
    return out;
  }

  /* ---------------------------------------------------------------- *
   * Operator surface
   * ---------------------------------------------------------------- */

  async listDiffs(orgId: string, channelId: number, query: ListSnapshotDiffsQueryInput) {
    const channel = await this.db.query.invChannels.findFirst({
      where: and(eq(invChannels.orgId, orgId), eq(invChannels.id, channelId)),
      columns: { id: true, snapshotPolicy: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");

    const conditions = [
      eq(invChannelSnapshotDiffs.orgId, orgId),
      eq(invChannelSnapshotDiffs.channelId, channelId),
      ...(query.status ? [eq(invChannelSnapshotDiffs.status, query.status)] : []),
    ];

    const offset = (query.page - 1) * query.limit;
    const [items, [countRow]] = await Promise.all([
      this.db
        .select({
          id: invChannelSnapshotDiffs.id,
          externalSku: invChannelSnapshotDiffs.externalSku,
          productVariantId: invChannelSnapshotDiffs.productVariantId,
          channelQty: invChannelSnapshotDiffs.channelQty,
          internalQty: invChannelSnapshotDiffs.internalQty,
          difference: invChannelSnapshotDiffs.difference,
          status: invChannelSnapshotDiffs.status,
          snapshotAt: invChannelSnapshotDiffs.snapshotAt,
          resolvedAt: invChannelSnapshotDiffs.resolvedAt,
          resolutionNote: invChannelSnapshotDiffs.resolutionNote,
          stockTransactionId: invChannelSnapshotDiffs.stockTransactionId,
        })
        .from(invChannelSnapshotDiffs)
        .where(and(...conditions))
        .orderBy(desc(invChannelSnapshotDiffs.snapshotAt))
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invChannelSnapshotDiffs)
        .where(and(...conditions)),
    ]);

    const total = countRow?.count ?? 0;
    return {
      items,
      total,
      page: query.page,
      totalPages: Math.ceil(total / query.limit),
      // So a screen can render "accepting is not permitted here" rather than
      // offering a button that 409s.
      snapshotPolicy: channel.snapshotPolicy,
    };
  }

  /**
   * Accept one difference, which posts one ordinary stock movement.
   *
   * This is the only path from a channel snapshot to the ledger, and every gate
   * E6 asks for sits on it:
   *
   *  - the channel's policy must be `ALLOW_ADJUSTMENT`, or it refuses;
   *  - the channel must name a reconciliation location, or it refuses rather
   *    than guessing where a correction belongs;
   *  - the movement goes through `StockEngineService.execute` under the
   *    operator's own user id, so warehouse scope, the accounting-period gate,
   *    costing and the outbox event all apply exactly as they do to a manual
   *    adjustment;
   *  - the idempotency key is derived from the difference row, so accepting the
   *    same difference twice posts once. That is what makes this an *idempotent
   *    command* rather than a button somebody can double-click into two
   *    movements.
   *
   * The status transition is guarded on `OPEN` and the affected-row count is
   * checked, so two operators racing produce one movement and one 409 rather
   * than two movements.
   */
  async acceptDiff(
    orgId: string,
    userId: string,
    diffId: number,
    input: ResolveSnapshotDiffInput,
  ) {
    const diff = await this.db.query.invChannelSnapshotDiffs.findFirst({
      where: and(eq(invChannelSnapshotDiffs.orgId, orgId), eq(invChannelSnapshotDiffs.id, diffId)),
    });
    if (!diff) throw new NotFoundException("Snapshot difference not found");
    if (diff.status !== "OPEN") {
      throw new ConflictException("This difference has already been resolved");
    }
    if (diff.productVariantId === null) {
      throw new BadRequestException(
        `The channel SKU "${diff.externalSku}" matches no product variant, so there is nothing to adjust. Map the SKU first, or dismiss this difference.`,
      );
    }

    const channel = await this.db.query.invChannels.findFirst({
      where: and(eq(invChannels.orgId, orgId), eq(invChannels.id, diff.channelId)),
      columns: { id: true, snapshotPolicy: true, reconciliationLocationId: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");

    if (channel.snapshotPolicy !== "ALLOW_ADJUSTMENT") {
      throw new ConflictException(
        "This channel's snapshot policy records differences only. A marketplace's stock figure is not permitted to move this ledger until an administrator changes the policy.",
      );
    }
    if (channel.reconciliationLocationId === null) {
      throw new BadRequestException(
        "This channel has no reconciliation location, so there is nowhere to post the correction. Set one on the channel first.",
      );
    }

    const result = await this.stockEngine.execute(orgId, userId, {
      // Derived from the row, not minted per request: accepting the same
      // difference twice claims the same key and posts nothing the second time.
      idempotencyKey: `channel-snapshot-diff:${diff.id}`,
      sourceType: "channel_snapshot_diff",
      sourceId: String(diff.id),
      reason: input.note,
      movements: [
        {
          transactionType: "ADJUSTMENT",
          productVariantId: diff.productVariantId,
          locationId: channel.reconciliationLocationId,
          quantityDelta: diff.difference,
        },
      ],
    });

    const transactionId = result.transactionIds[0] ?? null;
    const updated = await this.db
      .update(invChannelSnapshotDiffs)
      .set({
        status: "ACCEPTED",
        resolvedBy: userId,
        resolvedAt: new Date(),
        resolutionNote: input.note,
        stockTransactionId: transactionId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(invChannelSnapshotDiffs.orgId, orgId),
          eq(invChannelSnapshotDiffs.id, diffId),
          eq(invChannelSnapshotDiffs.status, "OPEN"),
        ),
      )
      .returning({ id: invChannelSnapshotDiffs.id });

    if (updated.length === 0) {
      // Lost the race. The engine's idempotency key means the winner's movement
      // is the only one that posted, so nothing has to be undone here.
      throw new ConflictException("This difference has already been resolved");
    }

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "channel.snapshot_difference_accepted",
      resourceType: "inv_channel_snapshot_diff",
      resourceId: String(diffId),
      metadata: { channelId: diff.channelId, difference: diff.difference, stockTransactionId: transactionId },
    });

    return { diffId, stockTransactionId: transactionId };
  }

  /** Close a difference without touching stock — the answer for a mapping error. */
  async dismissDiff(
    orgId: string,
    userId: string,
    diffId: number,
    input: ResolveSnapshotDiffInput,
  ) {
    const updated = await this.db
      .update(invChannelSnapshotDiffs)
      .set({
        status: "DISMISSED",
        resolvedBy: userId,
        resolvedAt: new Date(),
        resolutionNote: input.note,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(invChannelSnapshotDiffs.orgId, orgId),
          eq(invChannelSnapshotDiffs.id, diffId),
          eq(invChannelSnapshotDiffs.status, "OPEN"),
        ),
      )
      .returning({ id: invChannelSnapshotDiffs.id });

    if (updated.length === 0) {
      // 404 rather than 403 or 409 for a row in another tenant: a distinct
      // answer for "exists but not yours" turns a probe into an existence
      // oracle (§4).
      const exists = await this.db
        .select({ id: invChannelSnapshotDiffs.id })
        .from(invChannelSnapshotDiffs)
        .where(
          and(eq(invChannelSnapshotDiffs.orgId, orgId), eq(invChannelSnapshotDiffs.id, diffId)),
        )
        .limit(1);
      if (exists.length === 0) throw new NotFoundException("Snapshot difference not found");
      throw new ConflictException("This difference has already been resolved");
    }

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "channel.snapshot_difference_dismissed",
      resourceType: "inv_channel_snapshot_diff",
      resourceId: String(diffId),
      metadata: { note: input.note },
    });

    return { diffId };
  }
}

interface ChannelContext {
  readonly orgId: string;
  readonly channelId: number;
  readonly channelType: string;
  readonly storeUrl: string | null;
  readonly warehouseIds: number[];
  readonly skuToVariant: Map<string, number>;
}
