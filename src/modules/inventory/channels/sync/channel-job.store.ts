import { z } from "zod";
import type { ChannelAttemptPlan } from "../channel-adapter";
import type { ChannelSnapshotResult } from "../channel-adapter";
import type { ChannelContext } from "../lib/channel-snapshot-context";
import type {
  ChannelCallFailure,
  ChannelCommerceAdapter,
  ChannelStockOffer,
} from "./channel-commerce.port";

/**
 * INV-27 — every database question the channel-sync worker asks, named once.
 *
 * The worker is where the decisions are: which flow a job runs, what a partial
 * answer means, when a failure retries and when it dead-letters. Those are the
 * things that must be *proved*, and proving them through a Drizzle query builder
 * means faking a query builder, which mostly proves that the fake agrees with
 * itself. So the worker takes this interface, the Drizzle implementation lives
 * beside it in `channel-job.drizzle-store.ts`, and the specs supply an in-memory
 * one that enforces the two constraints the design actually leans on: the unique
 * natural key, and the sales order stamped onto the job in the same transaction
 * that creates it.
 *
 * That is a real limit and worth stating plainly: these specs assert the
 * decisions, not that the SQL is right. What makes the SQL right is migration
 * 1100 — `uniq_inv_channel_job_ref` and `chk_inv_channel_jobs_dead_has_reason` —
 * and the worker is written to rely on those rather than on a read-then-write it
 * could lose a race on.
 */

export type ChannelJobKind =
  | "STOCK_PUSH"
  | "STOCK_PULL"
  | "ORDER_PULL"
  | "ORDER_IMPORT"
  | "SHIP_CONFIRM";

export type ChannelJobStatus = "PENDING" | "PROCESSED" | "FAILED" | "DEAD";

/** One claimed row, with only the columns the worker reads. */
export interface ChannelJob {
  readonly id: number;
  readonly orgId: string;
  readonly channelId: number;
  readonly kind: ChannelJobKind;
  readonly externalRef: string;
  readonly attemptCount: number;
  readonly request: Record<string, unknown> | null;
  /** Non-null means an ORDER_IMPORT already produced an order. Never re-run it. */
  readonly salesOrderId: number | null;
  readonly enqueuedBy: string | null;
}

export interface NewChannelJob {
  readonly orgId: string;
  readonly channelId: number;
  readonly kind: ChannelJobKind;
  readonly externalRef: string;
  readonly request: Record<string, unknown> | null;
  readonly enqueuedBy: string | null;
}

/** What a channel job needs to know about its channel, plus the SKUs in play. */
export type ChannelSyncContext = ChannelContext & {
  readonly settings: Readonly<Record<string, unknown>>;
};

export interface PublicationOutcome {
  readonly accepted: readonly string[];
  readonly refused: readonly { readonly sku: string; readonly reason: string }[];
}

export type ImportOutcome =
  | { readonly applied: true; readonly salesOrderId: number }
  | { readonly applied: false; readonly code: string; readonly message: string; readonly terminal: boolean };

export interface ChannelJobStore {
  /** Everything about the channel this job names, or null if it is gone. */
  loadContext(orgId: string, channelId: number): Promise<ChannelSyncContext | null>;

  /**
   * What this channel was last told it may sell — `inv_channel_stock_publications`.
   * The push offers exactly that, rather than recomputing availability: the
   * figure an operator saw on the publications screen is the figure the
   * marketplace gets, and two independent computations of "available" is how E6's
   * predecessors ended up publishing a number nobody could reproduce.
   */
  readOffers(orgId: string, channelId: number): Promise<ChannelStockOffer[]>;

  /** Turn a snapshot into `inv_channel_snapshot_diffs` rows. Returns the count. */
  recordSnapshot(
    context: ChannelSyncContext,
    snapshot: Extract<ChannelSnapshotResult, { ok: true }>,
  ): Promise<number>;

  /** Correct the publication rows after a push actually reached the channel. */
  markPublications(orgId: string, channelId: number, outcome: PublicationOutcome): Promise<void>;

  /**
   * Insert a job if its natural key is free. `false` means the key was taken,
   * which for an ORDER_IMPORT is "we have already imported that order" and is
   * the ordinary case, not an error.
   */
  enqueue(job: NewChannelJob): Promise<boolean>;

  /**
   * Create the sales order for one imported channel order.
   *
   * **Contract:** the implementation writes the order AND stamps
   * `inv_channel_jobs.sales_order_id` in ONE transaction. A crash between the
   * two is the only way this design produces a duplicate order for a customer
   * who ordered once, so the fence is the transaction rather than the worker
   * remembering to call `complete`. A retry that finds `salesOrderId` already
   * set finishes the job without going near the sales-order tables.
   */
  applyImport(job: ChannelJob, order: ChannelOrderPayload): Promise<ImportOutcome>;

  /** PROCESSED, with what the channel answered. */
  complete(job: ChannelJob, response: Record<string, unknown>): Promise<void>;

  /** FAILED or DEAD, per the plan, with the reason and the attempt count. */
  fail(job: ChannelJob, plan: ChannelAttemptPlan, failure: ChannelCallFailure): Promise<void>;
}

/** Only the part of the registry the worker needs, so a spec can supply one function. */
export interface ChannelCommerceLookup {
  resolve(channelType: string | null | undefined): ChannelCommerceAdapter | null;
}

/* ------------------------------------------------------------------ *
 * Job payloads
 * ------------------------------------------------------------------ */

/**
 * An `ORDER_IMPORT` job's `request`, re-parsed rather than trusted.
 *
 * It was written by a previous sweep and has been sitting in a jsonb column,
 * possibly across a deploy that changed what an order looks like. Parsing it
 * means a stale payload dead-letters with a legible reason instead of producing
 * a sales order with an undefined quantity.
 */
export const channelOrderPayloadSchema = z.object({
  externalOrderId: z.string().min(1),
  externalOrderNumber: z.string().min(1),
  placedAt: z.string().min(1),
  currency: z.string().min(1),
  shippingAddress: z.string().nullable(),
  /*
    Capped, because `applyImport` turns every line into a bind parameter and
    postgres-js refuses a statement past 65,534 of them — a limit that fails the
    whole import rather than truncating it, which is at least honest but is not a
    thing to discover on a busy day. 500 is well above any real marketplace order
    (Shopify's own page size is 250) and an order beyond it dead-letters with a
    legible reason instead of a driver error.
  */
  lines: z
    .array(
      z.object({
        sku: z.string(),
        quantity: z.string().min(1),
        unitPrice: z.string().min(1),
      }),
    )
    .min(1)
    .max(500),
});
export type ChannelOrderPayload = z.infer<typeof channelOrderPayloadSchema>;

/** A `SHIP_CONFIRM` job's `request`. Same reasoning as above. */
export const channelShipPayloadSchema = z.object({
  salesOrderId: z.number().int().positive(),
  trackingNumber: z.string().nullable(),
  carrierName: z.string().nullable(),
  trackingUrl: z.string().nullable(),
  lines: z
    .array(z.object({ sku: z.string().min(1), quantity: z.string().min(1) }))
    .min(1),
});
export type ChannelShipPayload = z.infer<typeof channelShipPayloadSchema>;

/** An `ORDER_PULL` job's `request`: how far back to ask. */
export const channelPullPayloadSchema = z.object({
  since: z.string().min(1).nullable(),
});
