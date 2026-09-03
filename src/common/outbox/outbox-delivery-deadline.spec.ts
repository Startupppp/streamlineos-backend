/**
 * A consumer's `handle()` runs inside a tenant transaction — a pooled connection
 * held BEGIN to COMMIT — and two live chains reach a provider from inside it.
 * `ProjectsWebhooksDispatchService` spends 5 attempts x 10s plus up to 15s of
 * full-jitter backoff on an endpoint that accepts the connection and never
 * answers; `ExpenseSubmittedConsumer` reaches an LLM through `AutomationService`.
 * Both outrun the 30s lease AND the 60s `idle_in_transaction_session_timeout`,
 * so Postgres kills the connection, the failure write finds its lease already
 * re-claimed, and the retry count never advances — the event is re-delivered and
 * re-POSTed on every tick, indefinitely.
 */
import { Logger } from "@nestjs/common";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { OutboxReportService } from "./outbox-report.service";
import { OutboxConsumerRegistry, type OutboxEventRow } from "./outbox-consumer.registry";
import { OUTBOX_LEASE_MS } from "./outbox-claim";
import {
  OUTBOX_DELIVERY_DEADLINE_MS,
  OutboxDeliveryDeadlineError,
  withDeliveryDeadline,
} from "./outbox-delivery-deadline";
import { resolveTransactionGuards } from "../../db/pool.config";
import type { TenantTx } from "../tenant";

const mockForEachOrg = jest.fn();
const mockRunInNewTenantTransaction = jest.fn();

jest.mock("../tenant", () => ({
  forEachOrg: (...args: unknown[]) => mockForEachOrg(...args),
}));

jest.mock("../tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (...args: unknown[]) => mockRunInNewTenantTransaction(...args),
}));

interface RecordedUpdate {
  deliveryState?: string;
  retryCount?: number;
  publishedAt?: Date;
}

function makeRow(): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "evt-stuck",
    organizationId: "org-1",
    aggregateType: "project_webhook_delivery",
    aggregateId: "7",
    aggregateVersion: 7,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "IN_FLIGHT",
    eventType: "build.project-webhook.delivery.requested",
    payload: { deliveryId: 7 },
    occurredAt: new Date("2026-09-01T00:00:00.000Z"),
    publishedAt: null,
    leaseExpiresAt: new Date("2026-09-01T00:00:30.000Z"),
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

/** Every `.set()` the publisher wrote, in order — the bookkeeping it recorded. */
function harness(row: OutboxEventRow, handle: () => Promise<void>) {
  const writes: RecordedUpdate[] = [];

  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ status: "ACTIVE" }]) }) }),
    }),
  };

  mockForEachOrg.mockImplementation(
    async (_db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
      const chain = {
        update: () => ({
          set: () => ({ where: () => ({ returning: () => Promise.resolve([row]) }) }),
        }),
      };
      await fn(chain as never, row.organizationId);
      return { organizations: 1, succeeded: 1, failed: 0 };
    },
  );

  mockRunInNewTenantTransaction.mockImplementation(
    async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        ...db,
        update: () => ({
          set: (values: RecordedUpdate) => {
            writes.push(values);
            return { where: () => ({ returning: () => Promise.resolve([{ outboxEventId: 1 }]) }) };
          },
        }),
      }),
  );

  const registry = new OutboxConsumerRegistry();
  registry.register({ eventType: row.eventType, handle });

  const service = new OutboxPublisherService(
    db as never,
    { OUTBOX_DISPATCH_ENABLED: "true" } as never,
    registry,
    new OutboxReportService(db as never),
  );

  return { service, writes };
}

describe("outbox delivery deadline", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("sits below both bounds it has to respect — the DB's idle guard and the lease", () => {
    const idleGuardMs = resolveTransactionGuards(process.env).idleInTransactionMs;

    // Past the idle guard Postgres kills the connection and the delivery cannot
    // record what happened to it at all.
    expect(idleGuardMs).toBeGreaterThan(0);
    expect(OUTBOX_DELIVERY_DEADLINE_MS).toBeLessThan(idleGuardMs);

    // Past the lease the bookkeeping write can be fenced out by the next tick,
    // so `retryCount` never advances and the event is re-delivered forever.
    expect(OUTBOX_DELIVERY_DEADLINE_MS).toBeLessThan(OUTBOX_LEASE_MS);
    expect(OUTBOX_DELIVERY_DEADLINE_MS).toBeGreaterThan(0);
  });

  it("leaves room for the longest bounded consumer chain in the repo", () => {
    // ProjectsWebhooksDispatchService: 5 attempts x 10s, plus up to 1+2+4+8s of
    // full-jitter backoff — the chain the deadline exists to cut.
    const webhookWorstCaseMs = 5 * 10_000 + (1_000 + 2_000 + 4_000 + 8_000);
    expect(OUTBOX_DELIVERY_DEADLINE_MS).toBeLessThan(webhookWorstCaseMs);
    // …but not so tight that an ordinary multi-second consumer is cut with it.
    expect(OUTBOX_DELIVERY_DEADLINE_MS).toBeGreaterThan(30_000);
  });

  it("gives up on a consumer that never answers, and records a retry instead of hanging", async () => {
    jest.useFakeTimers();
    const row = makeRow();
    // A customer endpoint that accepts the connection and never responds.
    const { service, writes } = harness(row, () => new Promise<void>(() => undefined));

    const flushed = service.flush();
    await jest.advanceTimersByTimeAsync(OUTBOX_LEASE_MS);
    const result = await flushed;

    expect(result).toMatchObject({ claimed: 1, delivered: 0, retried: 1 });
    expect(writes).toEqual([
      expect.objectContaining({ deliveryState: "PENDING", retryCount: 1 }),
    ]);
  });

  it("gives up before the lease expires, not after the connection is killed", async () => {
    jest.useFakeTimers();
    const row = makeRow();
    const { service, writes } = harness(row, () => new Promise<void>(() => undefined));

    const flushed = service.flush();
    // One millisecond short of the deadline nothing has been recorded yet…
    await jest.advanceTimersByTimeAsync(OUTBOX_DELIVERY_DEADLINE_MS - 1);
    expect(writes).toEqual([]);
    // …and by the deadline the retry is written, with the lease still held.
    await jest.advanceTimersByTimeAsync(1);
    await flushed;
    expect(writes).toHaveLength(1);
  });

  it("still delivers a consumer that finishes inside the deadline", async () => {
    jest.useFakeTimers();
    const row = makeRow();
    const { service, writes } = harness(
      row,
      () => new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    );

    const flushed = service.flush();
    await jest.advanceTimersByTimeAsync(2_000);
    const result = await flushed;

    expect(result).toMatchObject({ claimed: 1, delivered: 1, retried: 0 });
    expect(writes).toEqual([expect.objectContaining({ deliveryState: "DELIVERED" })]);
  });
});

describe("withDeliveryDeadline — the abandoned promise stays observed", () => {
  afterEach(() => { jest.useRealTimers(); });

  it("hands a late rejection to onAbandoned rather than leaving it unhandled", async () => {
    const abandoned: unknown[] = [];
    let rejectLate: (error: Error) => void = () => undefined;
    const work = new Promise<void>((_resolve, reject) => { rejectLate = reject; });

    const raced = withDeliveryDeadline("test.event", 20, () => work, (e) => { abandoned.push(e); });
    await expect(raced).rejects.toBeInstanceOf(OutboxDeliveryDeadlineError);

    // What the rolled-back transaction does to the continuation still running on it.
    rejectLate(new Error("cannot perform operation: transaction is aborted"));
    await Promise.resolve();
    await Promise.resolve();

    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toBeInstanceOf(Error);
  });

  it("does not call onAbandoned when the consumer itself fails inside the deadline", async () => {
    const abandoned: unknown[] = [];
    const raced = withDeliveryDeadline(
      "test.event",
      10_000,
      () => Promise.reject(new Error("consumer blew up")),
      (e) => { abandoned.push(e); },
    );

    await expect(raced).rejects.toThrow("consumer blew up");
    expect(abandoned).toEqual([]);
  });

  it("clears its timer so a fast call does not hold the event loop open", async () => {
    const cleared: unknown[] = [];
    const realClear = global.clearTimeout;
    jest.spyOn(global, "clearTimeout").mockImplementation((id) => {
      cleared.push(id);
      return realClear(id);
    });

    await withDeliveryDeadline("test.event", 60_000, () => Promise.resolve("ok"), () => undefined);

    expect(cleared).toHaveLength(1);
    jest.restoreAllMocks();
  });
});
