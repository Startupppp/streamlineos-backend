import { KbIngestionConsumer } from "./kb-ingestion-consumer";
import { KbContentAdapterRegistry, KbPageAdapter, KbArticleAdapter, KbSourceAdapter, KbAttachmentAdapter } from "./kb-content-adapter";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";

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

function buildConsumer(options: {
  pageAdapterImpl?: (orgId: string, contentId: number) => Promise<void>;
} = {}) {
  const { pageAdapterImpl = async () => undefined } = options;

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
  );

  consumer.onModuleInit();

  return { consumer, adapterRegistry, outboxRegistry, pageAdapter };
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

      expect(pageAdapter.handle).toHaveBeenCalledWith(ORG_ID, CONTENT_ID);
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

      expect(pageAdapter.handle).toHaveBeenCalledWith(isolatedOrg, CONTENT_ID);
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
      expect(adapterFn.mock.calls[0]).toEqual([ORG_ID, CONTENT_ID]);
      expect(adapterFn.mock.calls[1]).toEqual([ORG_ID, CONTENT_ID]);
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
});
