import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { forEachOrg } from "../../../../common/tenant";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import {
  invChannelJobs,
  invChannels,
  invChannelStockPublications,
  invProductVariants,
  invSalesOrders,
  invSoLines,
} from "../../../../db/schema";
import { addDec, mulDec } from "../../stock-engine/decimal";
import { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import type { ChannelAttemptPlan } from "../channel-adapter";
import type { ChannelSnapshotResult } from "../channel-adapter";
import { loadChannelContext } from "../lib/channel-snapshot-context";
import { recordDifferences } from "../lib/channel-snapshot-diff";
import type { ChannelCallFailure, ChannelStockOffer } from "./channel-commerce.port";
import type {
  ChannelJob,
  ChannelJobStore,
  ChannelOrderPayload,
  ChannelSyncContext,
  ImportOutcome,
  NewChannelJob,
  PublicationOutcome,
} from "./channel-job.store";

/**
 * INV-27 — `ChannelJobStore` against the real database.
 *
 * Every method opens its own tenant transaction. That is not tidiness: a channel
 * job's adapter call is an HTTP request to a marketplace, and holding a pooled
 * Postgres connection for the length of somebody else's outage is exactly what
 * backend/CLAUDE.md §4 forbids. So the shape is read, close, call, write — the
 * same shape the E6 delivery drain uses, and the reason `claim` and `run` are
 * separate passes.
 *
 * The one method that does NOT split is `applyImport`, and its comment says why.
 */

/** How long a claimed job stays claimed if the drain dies mid-flight. */
export const CHANNEL_JOB_LEASE_MS = 120_000;

/** Jobs drained per organisation per sweep. */
export const CHANNEL_JOB_BATCH_SIZE = 25;

export class DrizzleChannelJobStore implements ChannelJobStore {
  constructor(
    private readonly db: Db,
    private readonly numbers: NumberSequenceService,
  ) {}

  /**
   * Claim every organisation's due work and lease it.
   *
   * `forEachOrg` is the only way a background sweep gets a tenant GUC at all,
   * and the lease is what stops two drains running the same job: a claimed row
   * is invisible to the next sweep until its lease expires, which is also how a
   * drain that died mid-flight releases its work rather than stranding it.
   */
  async claimDue(now: Date, batchSize = CHANNEL_JOB_BATCH_SIZE): Promise<ChannelJob[]> {
    const lease = new Date(now.getTime() + CHANNEL_JOB_LEASE_MS);
    const claimed: ChannelJob[] = [];

    await forEachOrg(this.db, "inventory-channel-sync", async (tx, orgId) => {
      const due = await tx
        .select({
          id: invChannelJobs.id,
          channelId: invChannelJobs.channelId,
          kind: invChannelJobs.kind,
          externalRef: invChannelJobs.externalRef,
          attemptCount: invChannelJobs.attemptCount,
          request: invChannelJobs.request,
          salesOrderId: invChannelJobs.salesOrderId,
          enqueuedBy: invChannelJobs.enqueuedBy,
        })
        .from(invChannelJobs)
        .where(
          and(
            eq(invChannelJobs.orgId, orgId),
            // DEAD is deliberately absent. A dead letter is retried by an
            // operator, never by the sweep that gave up on it.
            or(eq(invChannelJobs.status, "PENDING"), eq(invChannelJobs.status, "FAILED")),
            lte(invChannelJobs.nextAttemptAt, now),
            or(isNull(invChannelJobs.leaseExpiresAt), lte(invChannelJobs.leaseExpiresAt, now)),
          ),
        )
        .orderBy(asc(invChannelJobs.nextAttemptAt))
        .limit(batchSize);

      if (due.length === 0) return;

      await tx
        .update(invChannelJobs)
        .set({ leaseExpiresAt: lease, updatedAt: now })
        .where(
          and(
            eq(invChannelJobs.orgId, orgId),
            inArray(invChannelJobs.id, due.map((job) => job.id)),
          ),
        );

      for (const job of due) claimed.push({ ...job, orgId });
    });

    return claimed;
  }

  async loadContext(orgId: string, channelId: number): Promise<ChannelSyncContext | null> {
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const context = await loadChannelContext(tx, orgId, channelId);
      if (!context) return null;
      const channel = await tx.query.invChannels.findFirst({
        where: and(eq(invChannels.orgId, orgId), eq(invChannels.id, channelId)),
        columns: { settings: true },
      });
      return { ...context, settings: channel?.settings ?? {} };
    });
  }

  async readOffers(orgId: string, channelId: number): Promise<ChannelStockOffer[]> {
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const rows = await tx
        .select({
          sku: invProductVariants.sku,
          quantity: invChannelStockPublications.publishedQty,
        })
        .from(invChannelStockPublications)
        .innerJoin(
          invProductVariants,
          and(
            eq(invProductVariants.id, invChannelStockPublications.productVariantId),
            eq(invProductVariants.orgId, invChannelStockPublications.orgId),
            // Offers are what the channel may still sell, so a deleted variant
            // must not be offered — unlike a display join, where the historical
            // name is the point.
            isNull(invProductVariants.deletedAt),
          ),
        )
        .where(
          and(
            eq(invChannelStockPublications.orgId, orgId),
            eq(invChannelStockPublications.channelId, channelId),
          ),
        )
        // Bounded: a push that walked an unbounded publication set would hold the
        // sweep for one tenant's whole catalogue. The cap is the same page size
        // the adapter's own product walk uses.
        .limit(5_000);
      return rows.map((row) => ({ sku: row.sku, quantity: row.quantity }));
    });
  }

  async recordSnapshot(
    context: ChannelSyncContext,
    snapshot: Extract<ChannelSnapshotResult, { ok: true }>,
  ): Promise<number> {
    // `null` for the delivery: `inv_channel_snapshot_diffs.delivery_id` has been
    // nullable since 0570 precisely for "a scheduled sweep", which this is.
    return runInNewTenantTransaction(this.db, context.orgId, (tx) =>
      recordDifferences(tx, null, context, snapshot),
    );
  }

  async markPublications(
    orgId: string,
    channelId: number,
    outcome: PublicationOutcome,
  ): Promise<void> {
    const refusedBySku = new Map(outcome.refused.map((row) => [row.sku, row.reason]));
    const skus = [...outcome.accepted, ...refusedBySku.keys()];
    if (skus.length === 0) return;

    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const variants = await tx
        .select({ id: invProductVariants.id, sku: invProductVariants.sku })
        .from(invProductVariants)
        // `uniq_inv_product_variants_org_sku_live` is PARTIAL on
        // `deleted_at IS NULL`, so a SKU reused after a deletion matches BOTH
        // rows without this and the publication outcome lands on whichever the
        // loop below reached last.
        .where(
          and(
            eq(invProductVariants.orgId, orgId),
            inArray(invProductVariants.sku, skus),
            isNull(invProductVariants.deletedAt),
          ),
        );

      const now = new Date();
      for (const variant of variants) {
        const refusal = refusedBySku.get(variant.sku);
        await tx
          .update(invChannelStockPublications)
          .set({
            status: refusal ? "FAILED" : "PUBLISHED",
            error: refusal ?? null,
            publishedAt: refusal ? null : now,
            updatedAt: now,
          })
          .where(
            and(
              eq(invChannelStockPublications.orgId, orgId),
              eq(invChannelStockPublications.channelId, channelId),
              eq(invChannelStockPublications.productVariantId, variant.id),
            ),
          );
      }
    });
  }

  async enqueue(job: NewChannelJob): Promise<boolean> {
    return runInNewTenantTransaction(this.db, job.orgId, async (tx) => {
      const inserted = await tx
        .insert(invChannelJobs)
        .values({
          orgId: job.orgId,
          channelId: job.channelId,
          kind: job.kind,
          externalRef: job.externalRef,
          request: job.request ?? undefined,
          enqueuedBy: job.enqueuedBy,
        })
        // The unique natural key absorbs the duplicate. Nothing is read first:
        // a read-then-insert loses the race that matters here, which is two
        // pulls of the same busy channel overlapping.
        .onConflictDoNothing({
          target: [
            invChannelJobs.orgId,
            invChannelJobs.channelId,
            invChannelJobs.kind,
            invChannelJobs.externalRef,
          ],
        })
        .returning({ id: invChannelJobs.id });
      return inserted.length > 0;
    });
  }

  /**
   * One channel order becomes one sales order, in ONE transaction with the job
   * row that records it.
   *
   * The single-transaction requirement is the whole contract. A crash between
   * "sales order written" and "job says so" is the only way this design produces
   * a second order for a customer who ordered once, and the natural key cannot
   * help there because the job row already exists.
   */
  async applyImport(job: ChannelJob, order: ChannelOrderPayload): Promise<ImportOutcome> {
    /*
      Bound to a local before the guard, not read off `job` inside the callback
      below. A narrowing on `job.enqueuedBy` does not survive the closure
      boundary, so the alternative is a non-null assertion on the one value that
      must not be guessed — the author of somebody's sales order.
    */
    const actorUserId = job.enqueuedBy;
    if (!actorUserId) {
      // `inv_sales_orders.created_by` is NOT NULL and a background sweep has no
      // actor of its own. Refusing is better than attributing a customer's order
      // to whoever happened to be draining.
      return {
        applied: false,
        code: "NO_ACTOR",
        message: "This import records no operator, so the sales order it would raise has no author.",
        terminal: true,
      };
    }

    const skus = order.lines.map((line) => line.sku);
    if (skus.some((sku) => sku.trim().length === 0)) {
      return {
        applied: false,
        code: "LINE_WITHOUT_SKU",
        message: `Channel order ${order.externalOrderNumber} has a line with no SKU, so it cannot be matched to a product.`,
        terminal: true,
      };
    }

    return runInNewTenantTransaction(this.db, job.orgId, async (tx) => {
      const variants = await tx
        .select({
          id: invProductVariants.id,
          sku: invProductVariants.sku,
          costPrice: invProductVariants.costPrice,
        })
        .from(invProductVariants)
        // Same partial-unique caveat as the publication read above: without this
        // a reused SKU puts two rows into `bySku` and the second silently wins,
        // so a channel order could be costed against a deleted variant.
        .where(
          and(
            eq(invProductVariants.orgId, job.orgId),
            inArray(invProductVariants.sku, skus),
            isNull(invProductVariants.deletedAt),
          ),
        );

      const bySku = new Map(variants.map((variant) => [variant.sku, variant]));
      const unmatched = skus.filter((sku) => !bySku.has(sku));
      if (unmatched.length > 0) {
        // Terminal, and the most useful dead letter this flow produces: "the
        // channel sold something we do not stock" is a catalogue problem, and
        // retrying it four times will not create the product.
        return {
          applied: false as const,
          code: "UNKNOWN_SKU",
          message: `Channel order ${order.externalOrderNumber} names ${unmatched.length} SKU(s) this catalogue does not have: ${unmatched.slice(0, 5).join(", ")}.`,
          terminal: true,
        };
      }

      const resolved = order.lines.flatMap((line) => {
        const variant = bySku.get(line.sku);
        return variant ? [{ ...line, variant }] : [];
      });

      const channel = await tx.query.invChannels.findFirst({
        where: and(eq(invChannels.orgId, job.orgId), eq(invChannels.id, job.channelId)),
        columns: { warehouseIds: true },
      });

      let subtotal = "0";
      for (const line of order.lines) subtotal = addDec(subtotal, mulDec(line.quantity, line.unitPrice));

      const soNumber = await this.numbers.next(job.orgId, "SO", tx);
      const [created] = await tx
        .insert(invSalesOrders)
        .values({
          orgId: job.orgId,
          soNumber,
          // DRAFT, never CONFIRMED. A marketplace order arriving is not a
          // decision to promise stock against it; confirming is the ordinary
          // sales-order command, made by a person, with its own reservations.
          status: "DRAFT",
          orderDate: order.placedAt.slice(0, 10),
          shippingAddress: order.shippingAddress,
          // The channel's own warehouse list, first entry. Null when the channel
          // names none, which leaves the order a draft nobody can ship until
          // somebody chooses — the honest state.
          warehouseId: channel?.warehouseIds?.[0] ?? null,
          channelId: job.channelId,
          subtotal,
          taxAmount: "0",
          total: subtotal,
          currency: order.currency,
          notes: `Imported from channel order ${order.externalOrderNumber} (${order.externalOrderId}).`,
          createdBy: actorUserId,
        })
        .returning({ id: invSalesOrders.id });

      /*
        Resolved through `resolved`, not through a `?? 0` at the insert. Every
        SKU is known by now — `unmatched` returned above otherwise — so a
        fallback id would be unreachable code that silently writes variant 0 into
        a NOT NULL foreign key the day somebody edits the guard above it.
      */
      await tx.insert(invSoLines).values(
        resolved.map((line, index) => ({
          orgId: job.orgId,
          soId: created.id,
          productVariantId: line.variant.id,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          // Tax is deliberately zero. A marketplace's tax treatment is its own
          // and is not derivable from what its order payload carries; inventing
          // a rate here would put a number on an invoice that nobody computed.
          taxRate: "0",
          amount: mulDec(line.quantity, line.unitPrice),
          costAtTime: line.variant.costPrice,
          lineOrder: index,
        })),
      );

      // The stamp, in the same transaction. See the method comment.
      await tx
        .update(invChannelJobs)
        .set({ salesOrderId: created.id, updatedAt: new Date() })
        .where(and(eq(invChannelJobs.orgId, job.orgId), eq(invChannelJobs.id, job.id)));

      return { applied: true as const, salesOrderId: created.id };
    });
  }

  async complete(job: ChannelJob, response: Record<string, unknown>): Promise<void> {
    const now = new Date();
    await runInNewTenantTransaction(this.db, job.orgId, async (tx) => {
      await tx
        .update(invChannelJobs)
        .set({
          status: "PROCESSED",
          processedAt: now,
          attemptCount: job.attemptCount + 1,
          leaseExpiresAt: null,
          lastError: null,
          lastErrorCode: null,
          response,
          updatedAt: now,
        })
        .where(and(eq(invChannelJobs.orgId, job.orgId), eq(invChannelJobs.id, job.id)));
    });
  }

  async fail(
    job: ChannelJob,
    plan: ChannelAttemptPlan,
    failure: ChannelCallFailure,
  ): Promise<void> {
    const now = new Date();
    await runInNewTenantTransaction(this.db, job.orgId, async (tx) => {
      await tx
        .update(invChannelJobs)
        .set({
          status: plan.deadLettered ? "DEAD" : "FAILED",
          attemptCount: plan.attempts,
          lastErrorCode: failure.code,
          // Truncated, never dropped: `chk_inv_channel_jobs_dead_has_reason`
          // refuses a DEAD row with no message, which is the acceptance
          // ("visible, with the reason") enforced by the database.
          lastError: failure.message.slice(0, 1_000),
          deadLetteredAt: plan.deadLettered ? now : null,
          // The ladder decides when the next attempt happens. The lease is
          // released rather than extended: holding one past the retry time would
          // make the row invisible to the sweep meant to retry it.
          leaseExpiresAt: null,
          nextAttemptAt: plan.retryInMs === null ? now : new Date(now.getTime() + plan.retryInMs),
          updatedAt: now,
        })
        .where(and(eq(invChannelJobs.orgId, job.orgId), eq(invChannelJobs.id, job.id)));
    });
  }

  /**
   * An operator putting a dead letter back on the queue.
   *
   * `attempt_count` is deliberately NOT reset. The count is the thing an
   * operator is looking at — "this has failed six times" — and zeroing it every
   * time somebody presses retry would erase the only evidence that the channel
   * has a standing problem. The consequence is that a retried job gets one
   * attempt: `planChannelAttempt` dead-letters again immediately if it fails,
   * which is the right answer for somebody who has just fixed the cause and
   * wants to know whether they did.
   */
  async requeue(orgId: string, jobId: number): Promise<boolean> {
    const now = new Date();
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const updated = await tx
        .update(invChannelJobs)
        .set({
          status: "PENDING",
          nextAttemptAt: now,
          leaseExpiresAt: null,
          deadLetteredAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(invChannelJobs.orgId, orgId),
            eq(invChannelJobs.id, jobId),
            // Only a row that has actually failed. Requeueing a PROCESSED import
            // would be a request to raise a second sales order.
            or(eq(invChannelJobs.status, "DEAD"), eq(invChannelJobs.status, "FAILED")),
            isNull(invChannelJobs.salesOrderId),
          ),
        )
        .returning({ id: invChannelJobs.id });
      return updated.length > 0;
    });
  }

  /** The dead-letter screen's read: this channel's failures, newest first. */
  async listFailures(
    orgId: string,
    filters: { channelId?: number; status?: "FAILED" | "DEAD"; page: number; limit: number },
  ) {
    const conditions = [
      eq(invChannelJobs.orgId, orgId),
      filters.channelId === undefined ? undefined : eq(invChannelJobs.channelId, filters.channelId),
      filters.status
        ? eq(invChannelJobs.status, filters.status)
        : or(eq(invChannelJobs.status, "FAILED"), eq(invChannelJobs.status, "DEAD")),
    ].filter((condition): condition is SQL => condition !== undefined);

    const offset = (filters.page - 1) * filters.limit;
    const [items, [countRow]] = await Promise.all([
      this.db
        .select({
          id: invChannelJobs.id,
          channelId: invChannelJobs.channelId,
          kind: invChannelJobs.kind,
          externalRef: invChannelJobs.externalRef,
          status: invChannelJobs.status,
          attemptCount: invChannelJobs.attemptCount,
          lastErrorCode: invChannelJobs.lastErrorCode,
          lastError: invChannelJobs.lastError,
          nextAttemptAt: invChannelJobs.nextAttemptAt,
          deadLetteredAt: invChannelJobs.deadLetteredAt,
          createdAt: invChannelJobs.createdAt,
          updatedAt: invChannelJobs.updatedAt,
        })
        .from(invChannelJobs)
        .where(and(...conditions))
        .orderBy(desc(invChannelJobs.updatedAt))
        .limit(filters.limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invChannelJobs)
        .where(and(...conditions)),
    ]);

    const total = countRow?.count ?? 0;
    return { items, total, page: filters.page, totalPages: Math.ceil(total / filters.limit) };
  }
}
