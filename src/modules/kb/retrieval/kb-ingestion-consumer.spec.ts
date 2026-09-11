import { KbIngestionConsumer } from "./kb-ingestion-consumer";
import {
  KbIngestionLeaseService,
  KB_LEASE_CONTENDED_CODE,
  KB_LEASE_LOST_CODE,
  type KbIngestionLease,
} from "./kb-ingestion-lease.service";
import { KbContentAdapterRegistry, KbPageAdapter, KbArticleAdapter, KbSourceAdapter, KbAttachmentAdapter } from "./kb-content-adapter";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { OUTBOX_MAX_RETRIES } from "../../../common/outbox/outbox-envelope";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn().mockImplementation(
    async (_db: unknown, _orgId: string, fn: () => Promise<void>) => fn(),
  ),
}));

const ORG_ID = "org-kb-1";
const EVENT_ID = "evt-kb-aaa";
const CONTENT_ID = 99;

function makeEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "kb_page",
    aggregateId: String(CONTENT_ID),
    aggregateVersion: 1,
    eventType: "kb.content.index",
    payload: {
      contentType: "page",
      contentId: CONTENT_ID,
    },
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
    ...overrides,
  };
}

function makeLease(acquired = true): jest.Mocked<KbIngestionLeaseService> {
  const outcome: KbIngestionLease = acquired
    ? { status: "acquired", token: "tok-1" }
    : { status: "contended" };
  return {
    acquire: jest.fn().mockResolvedValue(outcome),
    release: jest.fn().mockResolvedValue(undefined),
    renew: jest.fn().mockResolvedValue({ status: "renewed" }),
    startHeartbeat: jest.fn().mockReturnValue({ stop: jest.fn(), lost: () => false }),
  } as unknown as jest.Mocked<KbIngestionLeaseService>;
}

const MOCK_DB = {} as never;

function buildConsumer(options: {
  pageAdapterImpl?: (orgId: string, contentId: number) => Promise<void>;
  lease?: jest.Mocked<KbIngestionLeaseService>;
} = {}) {
  const { pageAdapterImpl = async () => undefined, lease = makeLease() } = options;

  const pageAdapter = {
    contentType: "page",
    handle: jest.fn().mockImplementation(pageAdapterImpl),
  } as unknown as KbPageAdapter;

  const articleAdapter = {
    contentType: "article",
    handle: jest.fn().mockResolvedValue(undefined),
  } as unknown as KbArticleAdapter;

  const sourceAdapter = {
    contentType: "source",
    handle: jest.fn().mockResolvedValue(undefined),
  } as unknown as KbSourceAdapter;

  const attachmentAdapter = {
    contentType: "attachment",
    handle: jest.fn().mockResolvedValue(undefined),
  } as unknown as KbAttachmentAdapter;

  const adapterRegistry = new KbContentAdapterRegistry();
  const outboxRegistry = new OutboxConsumerRegistry();

  const consumer = new KbIngestionConsumer(
    adapterRegistry,
    outboxRegistry,
    pageAdapter,
    articleAdapter,
    sourceAdapter,
    attachmentAdapter,
    lease,
    MOCK_DB,
  );

  consumer.onModuleInit();

  return { consumer, adapterRegistry, outboxRegistry, pageAdapter, lease };
}

describe("KbIngestionConsumer", () => {
  describe("registration", () => {
    it("registers itself with the OutboxConsumerRegistry on init", () => {
      const { consumer, outboxRegistry } = buildConsumer();
      expect(outboxRegistry.get("kb.content.index")).toBe(consumer);
    });

    it("declares eventType = kb.content.index", () => {
      const { consumer } = buildConsumer();
      expect(consumer.eventType).toBe("kb.content.index");
    });

    it("registers all four content-type adapters into the KbContentAdapterRegistry", () => {
      const { adapterRegistry } = buildConsumer();
      expect(adapterRegistry.get("page")).toBeDefined();
      expect(adapterRegistry.get("article")).toBeDefined();
      expect(adapterRegistry.get("source")).toBeDefined();
      expect(adapterRegistry.get("attachment")).toBeDefined();
    });
  });

  describe("B1 — consumer correctness", () => {
    it("routes the event to the registered page adapter with orgId and contentId", async () => {
      const { consumer, pageAdapter } = buildConsumer();

      await consumer.handle(makeEvent());

      expect(pageAdapter.handle).toHaveBeenCalledWith(ORG_ID, CONTENT_ID, expect.any(AbortSignal));
    });

    it("throws for an unknown content type so the relay can dead-letter the poison event", async () => {
      const { consumer } = buildConsumer();

      await expect(
        consumer.handle(makeEvent({ payload: { contentType: "unsupported-type", contentId: CONTENT_ID } })),
      ).rejects.toThrow("Unhandled KB content type: unsupported-type");
    });
  });

  describe("B2 — no ambient tenant context needed", () => {
    it("routes using only event.organizationId — safe without ambient request context", async () => {
      const { consumer, pageAdapter } = buildConsumer();
      const isolatedOrg = "org-isolated-kb";

      await consumer.handle(makeEvent({ organizationId: isolatedOrg }));

      expect(pageAdapter.handle).toHaveBeenCalledWith(isolatedOrg, CONTENT_ID, expect.any(AbortSignal));
    });
  });

  describe("B3 — retry: adapter failure propagates", () => {
    it("propagates an adapter error so the outbox relay retries the event", async () => {
      const { consumer } = buildConsumer({
        pageAdapterImpl: async () => { throw new Error("embedding service down"); },
      });

      await expect(consumer.handle(makeEvent())).rejects.toThrow("embedding service down");
    });

    it("releases the per-org concurrency slot when the adapter throws", async () => {
      const { consumer } = buildConsumer({
        pageAdapterImpl: async () => { throw new Error("adapter failure"); },
      });

      await expect(consumer.handle(makeEvent())).rejects.toThrow("adapter failure");
      await expect(consumer.handle(makeEvent())).rejects.toThrow("adapter failure");
    });

    it("releases the lease when the adapter throws", async () => {
      const lease = makeLease();
      const { consumer } = buildConsumer({
        pageAdapterImpl: async () => { throw new Error("adapter failure"); },
        lease,
      });

      await expect(consumer.handle(makeEvent())).rejects.toThrow("adapter failure");

      expect(lease.release).toHaveBeenCalledWith(ORG_ID, "page", CONTENT_ID, "tok-1");
    });
  });

  describe("B4 — duplicate delivery: no inbox fence, adapter is idempotent", () => {
    it("calls the adapter twice when the same event is delivered twice (adapter idempotency expected)", async () => {
      const { consumer, pageAdapter } = buildConsumer();

      await consumer.handle(makeEvent());
      await consumer.handle(makeEvent());

      expect(pageAdapter.handle).toHaveBeenCalledTimes(2);
    });
  });

  describe("B5 — DLQ replay: adapter called with same args on retry", () => {
    it("calls the adapter with the same orgId and contentId on retry", async () => {
      const adapterFn = jest.fn()
        .mockRejectedValueOnce(new Error("transient failure"))
        .mockResolvedValueOnce(undefined);
      const { consumer } = buildConsumer({ pageAdapterImpl: adapterFn });

      await expect(consumer.handle(makeEvent())).rejects.toThrow("transient failure");
      await consumer.handle(makeEvent());

      expect(adapterFn).toHaveBeenCalledTimes(2);
      expect(adapterFn.mock.calls[0]).toEqual([ORG_ID, CONTENT_ID, expect.any(AbortSignal)]);
      expect(adapterFn.mock.calls[1]).toEqual([ORG_ID, CONTENT_ID, expect.any(AbortSignal)]);
    });
  });

  describe("per-org concurrency limit", () => {
    it("throws KB_CONCURRENCY_LIMIT when more than 20 events for the same org are in-flight", async () => {
      let resolveAll!: () => void;
      const blocker = new Promise<void>((resolve) => { resolveAll = resolve; });

      const { consumer } = buildConsumer({ pageAdapterImpl: () => blocker });

      const pending: Array<Promise<void>> = [];
      for (let i = 0; i < 20; i++)
        pending.push(consumer.handle(makeEvent({ aggregateId: String(i) })));

      await expect(
        consumer.handle(makeEvent({ aggregateId: "overflow" })),
      ).rejects.toThrow("KB_CONCURRENCY_LIMIT");

      resolveAll();
      await Promise.allSettled(pending);
    });
  });

  describe("payload validation", () => {
    it("throws when contentId is not a positive integer", async () => {
      const { consumer } = buildConsumer();
      const bad = makeEvent({ payload: { contentType: "page", contentId: "not-a-number" } });

      await expect(consumer.handle(bad)).rejects.toThrow();
    });
  });

  describe("L1 — lease exclusivity under concurrent claim", () => {
    it("BITE: a contended lease FAILS the delivery, so the outbox never marks the event DELIVERED", async () => {
      const contendedLease = makeLease(false);
      const { consumer } = buildConsumer({ lease: contendedLease });

      await expect(consumer.handle(makeEvent())).rejects.toThrow(KB_LEASE_CONTENDED_CODE);
    });

    it("does not call the adapter when the lease is not acquired", async () => {
      const contendedLease = makeLease(false);
      const { consumer, pageAdapter } = buildConsumer({ lease: contendedLease });

      await expect(consumer.handle(makeEvent())).rejects.toThrow(KB_LEASE_CONTENDED_CODE);

      expect(pageAdapter.handle).not.toHaveBeenCalled();
    });

    it("releases nothing when the lease was never acquired", async () => {
      const contendedLease = makeLease(false);
      const { consumer } = buildConsumer({ lease: contendedLease });

      await expect(consumer.handle(makeEvent())).rejects.toThrow(KB_LEASE_CONTENDED_CODE);

      expect(contendedLease.release).not.toHaveBeenCalled();
    });

    it("releases the lease after successful ingestion", async () => {
      const lease = makeLease();
      const { consumer } = buildConsumer({ lease });

      await consumer.handle(makeEvent());

      expect(lease.release).toHaveBeenCalledWith(ORG_ID, "page", CONTENT_ID, "tok-1");
    });

    it("heartbeats the lease for the length of the run and stops on the way out", async () => {
      const lease = makeLease();
      const stop = jest.fn();
      (lease.startHeartbeat as jest.Mock).mockReturnValue({ stop, lost: () => false });
      const { consumer } = buildConsumer({ lease });

      await consumer.handle(makeEvent());

      expect(lease.startHeartbeat).toHaveBeenCalledWith(ORG_ID, "page", CONTENT_ID, "tok-1");
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it("fails the delivery when the heartbeat lost the lease mid-run", async () => {
      const lease = makeLease();
      (lease.startHeartbeat as jest.Mock).mockReturnValue({ stop: jest.fn(), lost: () => true });
      const { consumer } = buildConsumer({ lease });

      await expect(consumer.handle(makeEvent())).rejects.toThrow(KB_LEASE_LOST_CODE);
    });
  });

  describe("D1 — the consumer does not second-guess the relay's dead-letter decision", () => {
    it("still ingests at the highest retryCount a consumer can observe", async () => {
      const { consumer, pageAdapter } = buildConsumer();

      await consumer.handle(makeEvent({ retryCount: OUTBOX_MAX_RETRIES - 1 }));

      expect(pageAdapter.handle).toHaveBeenCalledTimes(1);
    });
  });
});
