import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { invChannels } from "../../../../db/schema";
import { assertChannelEndpointAllowed } from "../channel-adapter";
import { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import { ChannelCommerceRegistry } from "./channel-commerce.port";
import { DrizzleChannelJobStore } from "./channel-job.drizzle-store";
import type { ChannelJobKind } from "./channel-job.store";
import {
  emptyOutcome,
  runChannelJob,
  type ChannelSyncOutcome,
} from "./channel-sync.worker";
import type { ConfirmShipmentInput, ListChannelFailuresInput } from "./dto/channel-sync.schemas";

/**
 * INV-27 — the seam's Nest face: enqueue, drain, show, retry.
 *
 * ## Nothing here talks to a marketplace
 *
 * Every operator-facing method does exactly one thing: write a durable row. The
 * marketplace is contacted by `drain()`, which runs outside any request from the
 * cron route, for the reason the E6 webhook receiver already gives — a
 * marketplace call inside a request transaction holds a pooled Postgres
 * connection for the length of somebody else's outage, and a channel that takes
 * twelve seconds would make an operator's button look broken.
 *
 * ## Why the run refs are minute-stamped
 *
 * `STOCK_PUSH`, `STOCK_PULL` and `ORDER_PULL` are runs rather than objects, so
 * they have no natural key of their own. They get `run:<ISO minute>`, which
 * makes the unique index a debounce: pressing Sync twice in the same minute
 * enqueues one push, and the second call answers `alreadyQueued` rather than
 * doubling the work. An order import and a ship confirm key on the channel's own
 * identifiers instead, where the key means something.
 */
@Injectable()
export class ChannelSyncService {
  private readonly logger = new Logger(ChannelSyncService.name);
  private readonly store: DrizzleChannelJobStore;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly numbers: NumberSequenceService,
    private readonly commerce: ChannelCommerceRegistry,
  ) {
    this.store = new DrizzleChannelJobStore(this.db, this.numbers);
  }

  /* ---------------------------------------------------------------- *
   * Enqueue
   * ---------------------------------------------------------------- */

  /**
   * One stock sync: push what we offer, then pull what the channel says.
   *
   * Two jobs, not one. A push that succeeded and a pull that timed out must not
   * report as one failure, because retrying the pair would re-push a figure the
   * channel has already taken.
   */
  async enqueueStockSync(orgId: string, userId: string, channelId: number) {
    await this.assertChannel(orgId, channelId);
    const ref = runRef();
    const [push, pull] = await Promise.all([
      this.store.enqueue({ orgId, channelId, kind: "STOCK_PUSH", externalRef: ref, request: null, enqueuedBy: userId }),
      this.store.enqueue({ orgId, channelId, kind: "STOCK_PULL", externalRef: ref, request: null, enqueuedBy: userId }),
    ]);
    return {
      queued: [push ? "STOCK_PUSH" : null, pull ? "STOCK_PULL" : null].filter(
        (kind): kind is ChannelJobKind => kind !== null,
      ),
      alreadyQueued: !push && !pull,
      connection: this.commerce.describe(await this.channelType(orgId, channelId)),
    };
  }

  async enqueueOrderPull(orgId: string, userId: string, channelId: number, since: string | undefined) {
    await this.assertChannel(orgId, channelId);
    const queued = await this.store.enqueue({
      orgId,
      channelId,
      kind: "ORDER_PULL",
      externalRef: runRef(),
      request: { since: since ?? null },
      enqueuedBy: userId,
    });
    return { queued, alreadyQueued: !queued };
  }

  /**
   * Tell the channel a parcel left.
   *
   * The natural key is the channel's order id, so one confirmation per channel
   * order. A split shipment therefore cannot be expressed yet — and that is
   * deliberate rather than an oversight: the Shopify adapter fulfils whole
   * fulfillment orders because our port does not carry the per-line ids a
   * partial fulfilment needs, and letting a second confirm through would tell a
   * customer more had shipped than did.
   */
  async enqueueShipConfirm(orgId: string, userId: string, channelId: number, body: ConfirmShipmentInput) {
    await this.assertChannel(orgId, channelId);
    const queued = await this.store.enqueue({
      orgId,
      channelId,
      kind: "SHIP_CONFIRM",
      externalRef: body.externalOrderId,
      request: {
        salesOrderId: body.salesOrderId,
        trackingNumber: body.trackingNumber,
        carrierName: body.carrierName,
        trackingUrl: body.trackingUrl,
        lines: body.lines.map((line) => ({ ...line })),
      },
      enqueuedBy: userId,
    });
    return { queued, alreadyConfirmed: !queued };
  }

  /* ---------------------------------------------------------------- *
   * Drain
   * ---------------------------------------------------------------- */

  /**
   * One sweep. Claim what is due across every organisation, run each job, and
   * never let one tenant's bad channel stop another's work — `runChannelJob`
   * cannot throw, which is what makes that true rather than hoped for.
   */
  async drain(): Promise<ChannelSyncOutcome & { claimed: number }> {
    const now = new Date();
    const claimed = await this.store.claimDue(now);
    const outcome = emptyOutcome();

    for (const job of claimed) {
      await runChannelJob(
        {
          store: this.store,
          commerce: this.commerce,
          assertEndpointAllowed: assertChannelEndpointAllowed,
        },
        job,
        outcome,
      );
    }

    if (outcome.dead > 0) {
      // A dead letter is the one outcome nobody is watching a response for, so
      // it is the one that has to announce itself. The row carries the detail;
      // this is the signal that there is a row to look at.
      this.logger.warn(
        `[inventory-channel-sync] ${outcome.dead} channel job(s) dead-lettered this sweep. ` +
          "They are listed at GET /inventory/channels/:channelId/sync/failures and can be retried there.",
      );
    }

    return { claimed: claimed.length, ...outcome };
  }

  /* ---------------------------------------------------------------- *
   * The operator's dead-letter surface
   * ---------------------------------------------------------------- */

  async listFailures(orgId: string, channelId: number, query: ListChannelFailuresInput) {
    await this.assertChannel(orgId, channelId);
    return this.store.listFailures(orgId, { channelId, ...query });
  }

  /**
   * Put one failed or dead job back on the queue.
   *
   * 404 rather than 403 for a job in another organisation — a 403 on another
   * org's id confirms the row exists (§4) — and 404 too for a job that is not in
   * a retryable state, because "this one has already produced its sales order"
   * is not a thing to let somebody re-run.
   */
  async retry(orgId: string, jobId: number) {
    const requeued = await this.store.requeue(orgId, jobId);
    if (!requeued) {
      throw new NotFoundException("No retryable channel job with this id");
    }
    return { retried: true, jobId };
  }

  describeConnection(channelType: string | null) {
    return this.commerce.describe(channelType);
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  /** 404 on another organisation's channel id, never 403 (§4). */
  private async assertChannel(orgId: string, channelId: number): Promise<void> {
    const channel = await this.db.query.invChannels.findFirst({
      where: and(eq(invChannels.orgId, orgId), eq(invChannels.id, channelId)),
      columns: { id: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");
  }

  private async channelType(orgId: string, channelId: number): Promise<string | null> {
    const channel = await this.db.query.invChannels.findFirst({
      where: and(eq(invChannels.orgId, orgId), eq(invChannels.id, channelId)),
      columns: { channelType: true },
    });
    return channel?.channelType ?? null;
  }
}

/**
 * `run:<ISO minute>` — see the class comment. Minute rather than millisecond so
 * that the unique index debounces a double-click instead of queueing two
 * identical pushes at a marketplace that rate-limits us.
 */
function runRef(): string {
  return `run:${new Date().toISOString().slice(0, 16)}`;
}
