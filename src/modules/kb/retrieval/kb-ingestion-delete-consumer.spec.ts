import { PgDialect } from "drizzle-orm/pg-core";
import { is, SQL } from "drizzle-orm";
import { KbIngestionDeleteConsumer } from "./kb-ingestion-delete-consumer";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { kbArticleChunks } from "../../../db/schema";

const dialect = new PgDialect();

function renderWhere(clause: unknown): { sql: string; params: unknown[] } {
  if (!is(clause, SQL)) return { sql: "", params: [] };
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: [...query.params] };
}

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

const ORG_ID = "org-del-1";
const PAGE_ID = 55;
const ARTICLE_ID = 66;

function makeEvent(contentType: string, contentId: number): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "evt-del-aaa",
    organizationId: ORG_ID,
    aggregateType: "kb_page",
    aggregateId: String(contentId),
    aggregateVersion: 1,
    eventType: "kb.content.delete",
    payload: { contentType, contentId },
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
  };
}

function makeTx() {
  const deleteWhere = jest.fn().mockResolvedValue([]);
  const txDelete = jest.fn().mockReturnValue({ where: deleteWhere });
  return { tx: { delete: txDelete }, txDelete, deleteWhere };
}

function getRunMock() {
  return jest.requireMock("../../../common/tenant/run-in-tenant-transaction")
    .runInNewTenantTransaction as jest.Mock;
}

function buildConsumer() {
  const outboxRegistry = new OutboxConsumerRegistry();
  const consumer = new KbIngestionDeleteConsumer(outboxRegistry, {} as never);
  consumer.onModuleInit();
  return { consumer, outboxRegistry };
}

beforeEach(() => {
  getRunMock().mockReset();
});

describe("KbIngestionDeleteConsumer", () => {
  describe("registration", () => {
    it("registers itself for kb.content.delete events", () => {
      const { consumer, outboxRegistry } = buildConsumer();
      expect(outboxRegistry.get("kb.content.delete")).toBe(consumer);
    });

    it("declares eventType = kb.content.delete", () => {
      const { consumer } = buildConsumer();
      expect(consumer.eventType).toBe("kb.content.delete");
    });
  });

  describe("P1 — delete propagates to chunks", () => {
    it("purges page chunks inside a tenant transaction — delete-propagates-to-chunks", async () => {
      const { tx, txDelete } = makeTx();
      getRunMock().mockImplementation(
        async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<void>) => fn(tx),
      );

      const { consumer } = buildConsumer();
      await consumer.handle(makeEvent("page", PAGE_ID));

      expect(getRunMock()).toHaveBeenCalledWith(
        expect.anything(),
        ORG_ID,
        expect.any(Function),
      );
      expect(txDelete).toHaveBeenCalledWith(kbArticleChunks);
    });

    it("anchors an article delete on page_id, because a support article IS a kb_pages row", async () => {
      const { tx, txDelete, deleteWhere } = makeTx();
      getRunMock().mockImplementation(
        async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<void>) => fn(tx),
      );

      const { consumer } = buildConsumer();
      await consumer.handle(makeEvent("article", ARTICLE_ID));

      expect(txDelete).toHaveBeenCalledWith(kbArticleChunks);
      const { sql, params } = renderWhere(deleteWhere.mock.calls[0]?.[0]);
      expect(sql).toContain(`"page_id"`);
      expect(sql).not.toContain(`"article_id"`);
      expect(params).toContain(ARTICLE_ID);
      expect(params).toContain(ORG_ID);
    });

    it("anchors article and page deletes on the same column, so neither content type can be missed", async () => {
      const { consumer } = buildConsumer();

      const rendered: string[] = [];
      for (const contentType of ["article", "page"]) {
        const { tx, deleteWhere } = makeTx();
        getRunMock().mockImplementation(
          async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<void>) => fn(tx),
        );
        await consumer.handle(makeEvent(contentType, PAGE_ID));
        rendered.push(renderWhere(deleteWhere.mock.calls[0]?.[0]).sql);
      }

      expect(rendered[0]).toContain(`"page_id"`);
      expect(rendered[0]).toBe(rendered[1]);
    });

    it("rejects an unknown contentType at the Zod schema boundary before any DB call", async () => {
      getRunMock().mockImplementation(
        async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<void>) =>
          fn({ delete: jest.fn().mockReturnValue({ where: jest.fn() }) }),
      );

      const { consumer } = buildConsumer();
      await expect(consumer.handle(makeEvent("unsupported-type", 42))).rejects.toThrow();
      expect(getRunMock()).not.toHaveBeenCalled();
    });
  });
});
