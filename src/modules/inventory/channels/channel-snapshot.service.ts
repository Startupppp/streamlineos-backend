import { Inject, Injectable, Logger } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { ChannelAdapterRegistry } from "./channel-adapter";
import { receiveDelivery } from "./lib/channel-snapshot-delivery";
import { drainPending } from "./lib/channel-snapshot-worker";
import {
  acceptDiff,
  dismissDiff,
  listDiffs,
  type ReviewDeps,
} from "./lib/channel-snapshot-review";
import type {
  ReceiveOutcome,
  SnapshotSweepResult,
} from "./lib/channel-snapshot-context";
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

/**
 * `ReceiveOutcome` and `SnapshotSweepResult` are re-exported because
 * `channel-snapshot.controller.ts` imports `SnapshotSweepResult` from here.
 */
export type { ReceiveOutcome, SnapshotSweepResult } from "./lib/channel-snapshot-context";

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
   * Inbound  — body in lib/channel-snapshot-delivery.ts
   * ---------------------------------------------------------------- */

  /** @see lib/channel-snapshot-delivery.ts */
  async receiveDelivery(input: {
    readonly channelId: number;
    readonly rawBody: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }): Promise<ReceiveOutcome> {
    return receiveDelivery(
      { db: this.db, config: this.config, logger: this.logger },
      input,
    );
  }

  /* ---------------------------------------------------------------- *
   * Drain  — body in lib/channel-snapshot-worker.ts
   * ---------------------------------------------------------------- */

  /** @see lib/channel-snapshot-worker.ts */
  async drainPending(): Promise<SnapshotSweepResult> {
    return drainPending({ db: this.db, adapters: this.adapters });
  }

  /* ---------------------------------------------------------------- *
   * Operator surface  — bodies in lib/channel-snapshot-review.ts
   * ---------------------------------------------------------------- */

  /** @see lib/channel-snapshot-review.ts */
  async listDiffs(orgId: string, channelId: number, query: ListSnapshotDiffsQueryInput) {
    return listDiffs(this.reviewDeps, orgId, channelId, query);
  }

  /** @see lib/channel-snapshot-review.ts */
  async acceptDiff(
    orgId: string,
    userId: string,
    diffId: number,
    body: ResolveSnapshotDiffInput,
  ) {
    return acceptDiff(this.reviewDeps, orgId, userId, diffId, body);
  }

  /** @see lib/channel-snapshot-review.ts */
  async dismissDiff(
    orgId: string,
    userId: string,
    diffId: number,
    body: ResolveSnapshotDiffInput,
  ) {
    return dismissDiff(this.reviewDeps, orgId, userId, diffId, body);
  }

  /**
   * Built explicitly rather than passing `this`: TypeScript will not
   * structurally match a class carrying `private` members to an interface.
   */
  private get reviewDeps(): ReviewDeps {
    return { db: this.db, stockEngine: this.stockEngine, audit: this.audit };
  }
}
