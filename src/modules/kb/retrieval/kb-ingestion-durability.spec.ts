import { KbIngestionConsumer } from "./kb-ingestion-consumer";
import {
  KbIngestionLeaseService,
  KB_LEASE_HEARTBEAT_MS,
  KB_LEASE_LOST_CODE,
  KB_LEASE_TTL_MS,
  KB_LEASE_TTL_SECONDS,
} from "./kb-ingestion-lease.service";
import { OUTBOX_LEASE_MS } from "../../../common/outbox/outbox-claim";
import {
  KbContentAdapterRegistry,
  type KbPageAdapter,
  type KbArticleAdapter,
  type KbSourceAdapter,
  type KbAttachmentAdapter,
} from "./kb-content-adapter";
import {
  OutboxConsumerRegistry,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn().mockImplementation(
    async (_db: unknown, _orgId: string, fn: () => Promise<void>) => fn(),
  ),
}));

const ORG_ID = "org-durability";
const CONTENT_ID = 77;

function silence(service: KbIngestionLeaseService): void {
  const holder = service as unknown as { logger: { error: (...a: unknown[]) => void } };
  jest.spyOn(holder.logger, "error").mockImplementation(() => undefined);
}

function makeEvent(): OutboxEventRow {
  return {
    outboxEventId: 9,
    eventId: "evt-durability-1",
    organizationId: ORG_ID,
    aggregateType: "kb_page",
    aggregateId: String(CONTENT_ID),
    aggregateVersion: 1,
    eventType: "kb.content.index",
    payload: { contentType: "page", contentId: CONTENT_ID },
    deliveryState: "IN_FLIGHT",
    retryCount: 0,
    schemaVersion: 1,
    audience: "INTERNAL",
    actorMembershipId: null,
    causationId: null,
    correlationId: null,
    occurredAt: new Date(),
    publishedAt: null,
    leaseExpiresAt: null,
    lastError: null,
    deadLetteredAt: null,
    lifecycleState: "ACTIVE",
    createdAt: new Date(),
  } as OutboxEventRow;
}

interface LeaseDouble {
  acquire: jest.Mock;
  release: jest.Mock;
  startHeartbeat: jest.Mock;
}

function buildConsumer(lease: LeaseDouble, pageAdapter: KbPageAdapter): KbIngestionConsumer {
  const noop = (contentType: string) =>
    ({ contentType, handle: jest.fn().mockResolvedValue(undefined) }) as unknown as never;
  const consumer = new KbIngestionConsumer(
    new KbContentAdapterRegistry(),
    new OutboxConsumerRegistry(),
    pageAdapter,
    noop("article") as unknown as KbArticleAdapter,
    noop("source") as unknown as KbSourceAdapter,
    noop("attachment") as unknown as KbAttachmentAdapter,
    lease as unknown as KbIngestionLeaseService,
    {} as never,
  );
  consumer.onModuleInit();
  return consumer;
}

function makeLeaseDouble(lost: boolean): { lease: LeaseDouble; stop: jest.Mock } {
  const stop = jest.fn();
  return {
    lease: {
      acquire: jest.fn().mockResolvedValue({ status: "acquired", token: "tok-1" }),
      release: jest.fn().mockResolvedValue(undefined),
      startHeartbeat: jest.fn().mockReturnValue({ stop, lost: () => lost }),
    },
    stop,
  };
}

const makeAdapter = () =>
  ({ contentType: "page", handle: jest.fn().mockResolvedValue(undefined) }) as unknown as KbPageAdapter;

describe("KB ingestion lease TTL — the module-level invariant bites", () => {
  it("the TTL the real outbox window derives is strictly shorter than that window", () => {
    expect(KB_LEASE_TTL_SECONDS * 1_000).toBeLessThan(OUTBOX_LEASE_MS);
    expect(KB_LEASE_HEARTBEAT_MS).toBeLessThan(KB_LEASE_TTL_MS);
  });

  it("BITE: the module refuses to load when the lease would outlive the re-claim window", async () => {
    await expect(
      jest.isolateModulesAsync(async () => {
        jest.doMock("../../../common/outbox/outbox-claim", () => ({ OUTBOX_LEASE_MS: 1_000 }));
        await import("./kb-ingestion-lease.service");
      }),
    ).rejects.toThrow(/must expire strictly before/);
    jest.dontMock("../../../common/outbox/outbox-claim");
  });
});

describe("KB ingestion heartbeat — an expired or stolen lease is detected", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps renewing while the stored token is still ours", async () => {
    jest.useFakeTimers();
    const redis = { eval: jest.fn().mockResolvedValue(1) };
    const service = new KbIngestionLeaseService(redis as never);
    const heartbeat = service.startHeartbeat(ORG_ID, "page", CONTENT_ID, "tok-1");

    await jest.advanceTimersByTimeAsync(KB_LEASE_HEARTBEAT_MS * 2);
    heartbeat.stop();

    expect(redis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(heartbeat.lost()).toBe(false);
    expect(service.health().lostCount).toBe(0);
  });

  it("flips to lost the moment the CAS stops matching — an expired or stolen lease", async () => {
    jest.useFakeTimers();
    const redis = { eval: jest.fn().mockResolvedValue(0) };
    const service = new KbIngestionLeaseService(redis as never);
    silence(service);
    const heartbeat = service.startHeartbeat(ORG_ID, "page", CONTENT_ID, "tok-1");
    expect(heartbeat.lost()).toBe(false);

    await jest.advanceTimersByTimeAsync(KB_LEASE_HEARTBEAT_MS);
    heartbeat.stop();

    expect(heartbeat.lost()).toBe(true);
    expect(service.health().lostCount).toBeGreaterThan(0);
  });

  it("stop() ends the renewals, so a finished run does not keep a key alive", async () => {
    jest.useFakeTimers();
    const redis = { eval: jest.fn().mockResolvedValue(1) };
    const service = new KbIngestionLeaseService(redis as never);
    const heartbeat = service.startHeartbeat(ORG_ID, "page", CONTENT_ID, "tok-1");

    await jest.advanceTimersByTimeAsync(KB_LEASE_HEARTBEAT_MS);
    const afterFirst = redis.eval.mock.calls.length;
    heartbeat.stop();
    await jest.advanceTimersByTimeAsync(KB_LEASE_HEARTBEAT_MS * 3);

    expect(redis.eval.mock.calls.length).toBe(afterFirst);
  });

  it("a transport failure is not a lost lease — it retries rather than declaring loss", async () => {
    const redis = { eval: jest.fn().mockRejectedValue(new Error("ECONNRESET")) };
    const service = new KbIngestionLeaseService(redis as never);

    const outcome = await service.renew(ORG_ID, "page", CONTENT_ID, "tok-1");

    expect(outcome.status).toBe("unavailable");
    expect(service.health().lostCount).toBe(0);
  });
});

describe("KbIngestionConsumer — a lost lease fails the delivery instead of reporting success", () => {
  it("throws after the adapter ran, so the outbox retries rather than marking it DELIVERED", async () => {
    const { lease } = makeLeaseDouble(true);
    const adapter = makeAdapter();
    const consumer = buildConsumer(lease, adapter);

    await expect(consumer.handle(makeEvent())).rejects.toThrow(KB_LEASE_LOST_CODE);
    expect(adapter.handle).toHaveBeenCalledTimes(1);
  });

  it("returns normally only when the heartbeat still holds the lease", async () => {
    const { lease } = makeLeaseDouble(false);
    const consumer = buildConsumer(lease, makeAdapter());

    await expect(consumer.handle(makeEvent())).resolves.toBeUndefined();
  });

  it("stops the heartbeat and releases the token on the lost path too", async () => {
    const { lease, stop } = makeLeaseDouble(true);
    const consumer = buildConsumer(lease, makeAdapter());

    await expect(consumer.handle(makeEvent())).rejects.toThrow(KB_LEASE_LOST_CODE);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledWith(ORG_ID, "page", CONTENT_ID, "tok-1");
  });

});

describe("KbIngestionConsumer — contention is a failure, never a silent drop", () => {
  function refusingLease(outcome: { status: string; reason?: string }): LeaseDouble {
    return {
      acquire: jest.fn().mockResolvedValue(outcome),
      release: jest.fn().mockResolvedValue(undefined),
      startHeartbeat: jest.fn(),
    };
  }

  it("a contended lease rejects and never runs the adapter", async () => {
    const adapter = makeAdapter();
    const lease = refusingLease({ status: "contended" });
    const consumer = buildConsumer(lease, adapter);

    await expect(consumer.handle(makeEvent())).rejects.toThrow(Error);
    expect(adapter.handle).not.toHaveBeenCalled();
    expect(lease.startHeartbeat).not.toHaveBeenCalled();
  });

  it("an unavailable lease rejects and never runs the adapter", async () => {
    const adapter = makeAdapter();
    const lease = refusingLease({ status: "unavailable", reason: "redis_not_configured" });
    const consumer = buildConsumer(lease, adapter);

    await expect(consumer.handle(makeEvent())).rejects.toThrow(Error);
    expect(adapter.handle).not.toHaveBeenCalled();
    expect(lease.startHeartbeat).not.toHaveBeenCalled();
  });

  it("holds no lease to release when it never acquired one", async () => {
    const lease = refusingLease({ status: "contended" });
    const consumer = buildConsumer(lease, makeAdapter());

    await expect(consumer.handle(makeEvent())).rejects.toThrow(Error);
    expect(lease.release).not.toHaveBeenCalled();
  });
});
