import { KbIngestionConsumer } from "./kb-ingestion-consumer";
import {
  KbIngestionLeaseService,
  KB_LEASE_CONTENDED_CODE,
  KB_LEASE_TTL_SECONDS,
  KB_LEASE_UNAVAILABLE_CODE,
  type KbIngestionLease,
} from "./kb-ingestion-lease.service";
import { OUTBOX_LEASE_MS } from "../../../common/outbox/outbox-claim";
import {
  KbContentAdapterRegistry,
  type KbPageAdapter,
  type KbArticleAdapter,
  type KbSourceAdapter,
  type KbAttachmentAdapter,
} from "./kb-content-adapter";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn().mockImplementation(
    async (_db: unknown, _orgId: string, fn: () => Promise<void>) => fn(),
  ),
}));

const ORG_ID = "org-lease";
const CONTENT_ID = 42;

function makeEvent(): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "evt-lease-1",
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

interface InterleaveRecorder {
  events: string[];
  maxConcurrent: number;
}

function makeTracingAdapter(recorder: InterleaveRecorder) {
  let active = 0;
  let releaseBarrier: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const adapter = {
    contentType: "page",
    handle: jest.fn().mockImplementation(async () => {
      active += 1;
      recorder.maxConcurrent = Math.max(recorder.maxConcurrent, active);
      recorder.events.push("enter");
      await barrier;
      recorder.events.push("exit");
      active -= 1;
    }),
  } as unknown as KbPageAdapter;
  return { adapter, open: () => releaseBarrier?.() };
}

function buildConsumer(
  lease: Pick<KbIngestionLeaseService, "acquire" | "release" | "startHeartbeat">,
  pageAdapter: KbPageAdapter,
) {
  const noop = (contentType: string) =>
    ({ contentType, handle: jest.fn().mockResolvedValue(undefined) }) as unknown as never;
  const adapterRegistry = new KbContentAdapterRegistry();
  const outboxRegistry = new OutboxConsumerRegistry();
  const consumer = new KbIngestionConsumer(
    adapterRegistry,
    outboxRegistry,
    pageAdapter,
    noop("article") as unknown as KbArticleAdapter,
    noop("source") as unknown as KbSourceAdapter,
    noop("attachment") as unknown as KbAttachmentAdapter,
    lease as KbIngestionLeaseService,
    {} as never,
  );
  consumer.onModuleInit();
  return consumer;
}

describe("KbIngestionLeaseService — the degraded path is closed, not open", () => {
  it("refuses to grant a lease when Redis is not configured", async () => {
    const service = new KbIngestionLeaseService(null);
    const lease = await service.acquire(ORG_ID, "page", CONTENT_ID);

    expect(lease.status).toBe("unavailable");
    if (lease.status !== "unavailable") throw new Error("expected unavailable");
    expect(lease.reason).toBe("redis_not_configured");
  });

  it("refuses to grant a lease when Redis errors", async () => {
    const redis = { set: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    const service = new KbIngestionLeaseService(redis as never);
    const lease = await service.acquire(ORG_ID, "page", CONTENT_ID);

    expect(lease.status).toBe("unavailable");
    if (lease.status !== "unavailable") throw new Error("expected unavailable");
    expect(lease.reason).toContain("ECONNREFUSED");
  });

  it("distinguishes a held lease (contended) from a missing lease service (unavailable)", async () => {
    const redis = { set: jest.fn().mockResolvedValue(null) };
    const service = new KbIngestionLeaseService(redis as never);

    expect((await service.acquire(ORG_ID, "page", CONTENT_ID)).status).toBe("contended");
  });

  it("grants a token only on a real NX write", async () => {
    const redis = { set: jest.fn().mockResolvedValue("OK") };
    const service = new KbIngestionLeaseService(redis as never);
    const lease = await service.acquire(ORG_ID, "page", CONTENT_ID);

    expect(lease.status).toBe("acquired");
    if (lease.status !== "acquired") throw new Error("expected acquired");
    expect(lease.token).toHaveLength(36);
    expect(redis.set).toHaveBeenCalledWith(
      `kb:ingest:lease:${ORG_ID}:page:${CONTENT_ID}`,
      lease.token,
      { ex: KB_LEASE_TTL_SECONDS, nx: true },
    );
  });

  it("BITE: the TTL expires before the outbox re-claims, so a crashed worker cannot block its own redelivery", () => {
    expect(KB_LEASE_TTL_SECONDS * 1_000).toBeLessThan(OUTBOX_LEASE_MS);
  });

  it("renews only for the token that holds the lease", async () => {
    const redis = { eval: jest.fn().mockResolvedValue(1) };
    const service = new KbIngestionLeaseService(redis as never);

    expect(await service.renew(ORG_ID, "page", CONTENT_ID, "tok")).toEqual({ status: "renewed" });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("expire"),
      [`kb:ingest:lease:${ORG_ID}:page:${CONTENT_ID}`],
      ["tok", String(KB_LEASE_TTL_SECONDS)],
    );
  });

  it("reports a lost lease when the stored token is no longer ours", async () => {
    const redis = { eval: jest.fn().mockResolvedValue(0) };
    const service = new KbIngestionLeaseService(redis as never);
    jest
      .spyOn((service as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, "error")
      .mockImplementation(() => undefined);

    expect(await service.renew(ORG_ID, "page", CONTENT_ID, "tok")).toEqual({ status: "lost" });
    expect(service.health().lostCount).toBe(1);
  });

  it("carries no boolean an unwary caller could read as permission to proceed", async () => {
    const service = new KbIngestionLeaseService(null);
    const lease: KbIngestionLease = await service.acquire(ORG_ID, "page", CONTENT_ID);

    expect(lease).not.toHaveProperty("acquired");
    expect(lease).not.toHaveProperty("token");
  });
});

describe("KbIngestionLeaseService — the degraded path is observable", () => {
  it("counts every refusal and records the latest reason", async () => {
    const service = new KbIngestionLeaseService(null);
    await service.acquire(ORG_ID, "page", 1);
    await service.acquire(ORG_ID, "page", 2);

    expect(service.health()).toEqual({
      unavailableCount: 2,
      contendedCount: 0,
      lostCount: 0,
      lastUnavailableReason: "redis_not_configured",
    });
  });

  it("logs the refusal at error level with a greppable code, not a silent warning", async () => {
    const service = new KbIngestionLeaseService(null);
    const spy = jest
      .spyOn((service as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, "error")
      .mockImplementation(() => undefined);

    await service.acquire(ORG_ID, "page", CONTENT_ID);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain(KB_LEASE_UNAVAILABLE_CODE);
    spy.mockRestore();
  });

  it("counts contention separately from unavailability", async () => {
    const redis = { set: jest.fn().mockResolvedValue(null) };
    const service = new KbIngestionLeaseService(redis as never);
    await service.acquire(ORG_ID, "page", CONTENT_ID);

    expect(service.health().contendedCount).toBe(1);
    expect(service.health().unavailableCount).toBe(0);
  });
});

describe("KbIngestionConsumer — no Redis means no ingestion, not unguarded ingestion", () => {
  it("does not run the adapter and surfaces the unavailable code to the outbox", async () => {
    const recorder: InterleaveRecorder = { events: [], maxConcurrent: 0 };
    const { adapter, open } = makeTracingAdapter(recorder);
    const lease = new KbIngestionLeaseService(null);
    jest
      .spyOn((lease as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, "error")
      .mockImplementation(() => undefined);
    const consumer = buildConsumer(lease, adapter);
    open();

    await expect(consumer.handle(makeEvent())).rejects.toThrow(KB_LEASE_UNAVAILABLE_CODE);
    expect(adapter.handle).not.toHaveBeenCalled();
  });

  it("two concurrent deliveries with no Redis produce zero interleaved runs", async () => {
    const recorder: InterleaveRecorder = { events: [], maxConcurrent: 0 };
    const { adapter, open } = makeTracingAdapter(recorder);
    const lease = new KbIngestionLeaseService(null);
    jest
      .spyOn((lease as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, "error")
      .mockImplementation(() => undefined);
    const consumer = buildConsumer(lease, adapter);

    const results = await Promise.allSettled([
      consumer.handle(makeEvent()),
      consumer.handle(makeEvent()),
    ]);
    open();

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(recorder.maxConcurrent).toBe(0);
    expect(adapter.handle).not.toHaveBeenCalled();
  });

  it("BITE — a lease that grants itself when Redis is absent lets two runs interleave on one document", async () => {
    const recorder: InterleaveRecorder = { events: [], maxConcurrent: 0 };
    const { adapter, open } = makeTracingAdapter(recorder);
    const failOpenLease = {
      acquire: jest.fn().mockResolvedValue({ status: "acquired", token: "" }),
      release: jest.fn().mockResolvedValue(undefined),
      startHeartbeat: jest.fn().mockReturnValue({ stop: jest.fn(), lost: () => false }),
    };
    const consumer = buildConsumer(failOpenLease, adapter);

    const inFlight = Promise.all([consumer.handle(makeEvent()), consumer.handle(makeEvent())]);
    await Promise.resolve();
    await Promise.resolve();
    open();
    await inFlight;

    expect(recorder.maxConcurrent).toBe(2);
    expect(recorder.events.slice(0, 2)).toEqual(["enter", "enter"]);
    expect(adapter.handle).toHaveBeenCalledTimes(2);
  });

  it("a genuinely contended lease fails the event too — a normal return would mark it DELIVERED", async () => {
    const recorder: InterleaveRecorder = { events: [], maxConcurrent: 0 };
    const { adapter, open } = makeTracingAdapter(recorder);
    const redis = { set: jest.fn().mockResolvedValue(null) };
    const lease = new KbIngestionLeaseService(redis as never);
    const consumer = buildConsumer(lease, adapter);
    open();

    await expect(consumer.handle(makeEvent())).rejects.toThrow(KB_LEASE_CONTENDED_CODE);
    expect(adapter.handle).not.toHaveBeenCalled();
  });

  it("releases the lease it actually holds after a successful run", async () => {
    const recorder: InterleaveRecorder = { events: [], maxConcurrent: 0 };
    const { adapter, open } = makeTracingAdapter(recorder);
    const redis = { set: jest.fn().mockResolvedValue("OK") };
    const lease = new KbIngestionLeaseService(redis as never);
    const releaseSpy = jest.spyOn(lease, "release").mockResolvedValue(undefined);
    const consumer = buildConsumer(lease, adapter);

    const run = consumer.handle(makeEvent());
    open();
    await run;

    expect(releaseSpy).toHaveBeenCalledWith(ORG_ID, "page", CONTENT_ID, expect.any(String));
  });
});
