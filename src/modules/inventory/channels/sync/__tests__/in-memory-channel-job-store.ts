import type { ChannelAttemptPlan, ChannelSnapshotResult } from "../../channel-adapter";
import type { ChannelCallFailure, ChannelStockOffer } from "../channel-commerce.port";
import type {
  ChannelJob,
  ChannelJobKind,
  ChannelJobStatus,
  ChannelJobStore,
  ChannelOrderPayload,
  ChannelSyncContext,
  ImportOutcome,
  NewChannelJob,
  PublicationOutcome,
} from "../channel-job.store";

/**
 * INV-27 — `inv_channel_jobs` in memory, with the two constraints the design
 * leans on and nothing else.
 *
 * Those two are:
 *
 *  1. **`uniq_inv_channel_job_ref`** — `(org, channel, kind, external_ref)` is
 *     unique, so `enqueue` reports `false` on a clash exactly as
 *     `onConflictDoNothing().returning()` does. This is order-import
 *     idempotency, and a fake that did not enforce it would let the specs pass
 *     over a design that does not work.
 *  2. **`applyImport` writes the order and stamps the job together.** The
 *     Drizzle implementation does that in one transaction; this one does it in
 *     one statement, which is the same fact for the purpose of the assertion
 *     that a second run of the same job creates nothing.
 *
 * Written as a class implementing the interface, not as a `jest.fn()` bag cast
 * to it: a cast would let the interface drift from the thing under test, and the
 * drift would look like a passing suite.
 */

export interface StoredJob extends ChannelJob {
  status: ChannelJobStatus;
  lastError: string | null;
  lastErrorCode: string | null;
  nextAttemptAt: Date;
  deadLetteredAt: Date | null;
  response: Record<string, unknown> | null;
}

export interface InMemoryFixture {
  readonly context: ChannelSyncContext | null;
  readonly offers: readonly ChannelStockOffer[];
  /** SKUs this catalogue has. An order naming anything else cannot be imported. */
  readonly knownSkus: readonly string[];
}

export class InMemoryChannelJobStore implements ChannelJobStore {
  readonly jobs: StoredJob[] = [];
  readonly publications: PublicationOutcome[] = [];
  readonly snapshots: Array<Extract<ChannelSnapshotResult, { ok: true }>> = [];
  readonly salesOrders: Array<{ id: number; jobId: number; externalOrderNumber: string }> = [];

  private nextJobId = 1;
  private nextOrderId = 9000;

  constructor(private readonly fixture: InMemoryFixture) {}

  /** Put a job on the queue as if an operator had asked for it. */
  seed(job: Partial<StoredJob> & Pick<StoredJob, "kind">): StoredJob {
    const stored: StoredJob = {
      id: this.nextJobId++,
      orgId: job.orgId ?? "org-1",
      channelId: job.channelId ?? 1,
      kind: job.kind,
      externalRef: job.externalRef ?? `run:${this.nextJobId}`,
      attemptCount: job.attemptCount ?? 0,
      request: job.request ?? null,
      salesOrderId: job.salesOrderId ?? null,
      enqueuedBy: job.enqueuedBy ?? "user-1",
      status: job.status ?? "PENDING",
      lastError: job.lastError ?? null,
      lastErrorCode: job.lastErrorCode ?? null,
      nextAttemptAt: job.nextAttemptAt ?? new Date(0),
      deadLetteredAt: job.deadLetteredAt ?? null,
      response: job.response ?? null,
    };
    this.jobs.push(stored);
    return stored;
  }

  byKind(kind: ChannelJobKind): StoredJob[] {
    return this.jobs.filter((job) => job.kind === kind);
  }

  async loadContext(): Promise<ChannelSyncContext | null> {
    return this.fixture.context;
  }

  async readOffers(): Promise<ChannelStockOffer[]> {
    return [...this.fixture.offers];
  }

  async recordSnapshot(
    _context: ChannelSyncContext,
    snapshot: Extract<ChannelSnapshotResult, { ok: true }>,
  ): Promise<number> {
    this.snapshots.push(snapshot);
    // One difference per SKU the channel actually mentioned — enough for the
    // worker's assertions; the real rule is `planSnapshotDifferences`, which has
    // its own specs in `__tests__/channel-snapshot.service.spec.ts`.
    return snapshot.items.length;
  }

  async markPublications(
    _orgId: string,
    _channelId: number,
    outcome: PublicationOutcome,
  ): Promise<void> {
    this.publications.push(outcome);
  }

  async enqueue(job: NewChannelJob): Promise<boolean> {
    const clash = this.jobs.some(
      (existing) =>
        existing.orgId === job.orgId &&
        existing.channelId === job.channelId &&
        existing.kind === job.kind &&
        existing.externalRef === job.externalRef,
    );
    if (clash) return false;
    this.seed({ ...job, request: job.request ?? null });
    return true;
  }

  async applyImport(job: ChannelJob, order: ChannelOrderPayload): Promise<ImportOutcome> {
    const unmatched = order.lines
      .map((line) => line.sku)
      .filter((sku) => !this.fixture.knownSkus.includes(sku));
    if (unmatched.length > 0) {
      return {
        applied: false,
        code: "UNKNOWN_SKU",
        message: `Channel order ${order.externalOrderNumber} names ${unmatched.length} SKU(s) this catalogue does not have: ${unmatched.join(", ")}.`,
        terminal: true,
      };
    }

    const salesOrderId = this.nextOrderId++;
    this.salesOrders.push({
      id: salesOrderId,
      jobId: job.id,
      externalOrderNumber: order.externalOrderNumber,
    });
    // The stamp, together with the order. See the header.
    this.patch(job.id, { salesOrderId });
    return { applied: true, salesOrderId };
  }

  async complete(job: ChannelJob, response: Record<string, unknown>): Promise<void> {
    this.patch(job.id, {
      status: "PROCESSED",
      attemptCount: job.attemptCount + 1,
      lastError: null,
      lastErrorCode: null,
      response,
    });
  }

  async fail(
    job: ChannelJob,
    plan: ChannelAttemptPlan,
    failure: ChannelCallFailure,
  ): Promise<void> {
    const now = new Date("2026-09-12T00:00:00Z");
    this.patch(job.id, {
      status: plan.deadLettered ? "DEAD" : "FAILED",
      attemptCount: plan.attempts,
      lastError: failure.message,
      lastErrorCode: failure.code,
      deadLetteredAt: plan.deadLettered ? now : null,
      nextAttemptAt: plan.retryInMs === null ? now : new Date(now.getTime() + plan.retryInMs),
    });
  }

  private patch(id: number, changes: Partial<StoredJob>): void {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job) throw new Error(`no job ${id}`);
    Object.assign(job, changes);
  }
}
