import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbArticleReindexService } from "./kb-article-reindex.service";
import { KbIndexingService } from "./kb-indexing.service";
import { KbIngestionCheckpointService } from "./kb-ingestion-checkpoint.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const rec = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(rec.queryChunks ? sqlValues(rec.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec.value, seen) : []),
  ];
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

function makeSelectChain(rows: unknown[] = []) {
  const where = jest.fn();
  const chain = {
    then: (fn: (v: unknown[]) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
    limit: jest.fn(),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
  };
  chain.limit.mockReturnValue(chain);
  chain.groupBy.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  where.mockReturnValue(chain);
  return { where, chain };
}

/**
 * `loadCheckpoints` opens its own tenant transaction — `kb_ingestion_checkpoints` is
 * RLS-enabled under the RAISING `org_id = current_org_id()` and both reindex routes enter
 * the service with no ambient context, so the read has to supply one. A mock `db` with no
 * `transaction` therefore no longer models the seam. It gets one here that INVOKES its
 * callback (backend CLAUDE.md 8: a bare `jest.fn()` silently voids every assertion inside),
 * handing back a tx that carries the same select chain, so the predicate assertions below
 * still inspect the real `where` argument.
 */
function makeCheckpointDb(rows: unknown[]) {
  const { where } = makeSelectChain(rows);
  const txSelect = jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) });
  const tx = { select: txSelect, execute: jest.fn().mockResolvedValue([]) };
  // `withTenant` fires `refreshRelocationTargets(db, …)` against the OUTER handle, so the
  // instrumented chain belongs to the transaction only — sharing one would make
  // `where.mock.calls[0]` the relocation probe and the predicate assertion vacuous.
  const outerSelect = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  });
  const db = {
    select: outerSelect,
    transaction: jest.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as Db;
  return { db, where };
}

describe("KbIngestionCheckpointService — cross-tenant isolation", () => {
  it("loadCheckpoints: where predicate carries attacker orgId (deny — scoped to caller)", async () => {
    const { db, where } = makeCheckpointDb([]);
    const svc = new KbIngestionCheckpointService(db);
    const result = await svc.loadCheckpoints(ATTACKER, "article", 1, "hash");
    expect(result.size).toBe(0);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("loadCheckpoints: returns checkpoints for the owning org (control)", async () => {
    const { db, where } = makeCheckpointDb([{ chunkIndex: 0, embedding: [0.1, 0.2] }]);
    const svc = new KbIngestionCheckpointService(db);
    const result = await svc.loadCheckpoints(OWNER, "article", 1, "hash");
    expect(result.size).toBe(1);
    expect(result.get(0)).toEqual([0.1, 0.2]);
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(OWNER);
  });
});

describe("KbArticleReindexService — cross-tenant isolation", () => {
  it("reindexArticle: throws NotFoundException for an article in a different org (deny)", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const db = { query: { kbPages: { findFirst } } } as unknown as Db;
    const indexing = {} as never;
    const attachmentIndexing = {} as never;
    const svc = new KbArticleReindexService(db, indexing, attachmentIndexing);
    await expect(svc.reindexArticle(ATTACKER, 99)).rejects.toThrow(NotFoundException);
    expect(findFirst).toHaveBeenCalled();
    const vals = sqlValues(findFirst.mock.calls[0]?.[0]?.where);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("reindexArticle: calls indexing for the owning org (control)", async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 99 });
    const attachmentsFindMany = jest.fn().mockResolvedValue([]);
    const { where: chunksWhere } = makeSelectChain([{ chunks: 0 }]);
    const chunksFrom = jest.fn().mockReturnValue({ where: chunksWhere });
    const db = {
      query: {
        kbPages: { findFirst },
        kbPageAttachments: { findMany: attachmentsFindMany },
      },
      select: jest.fn().mockReturnValue({ from: chunksFrom }),
    } as unknown as Db;
    const indexing = { indexArticle: jest.fn().mockResolvedValue(undefined) } as never;
    const attachmentIndexing = {} as never;
    const svc = new KbArticleReindexService(db, indexing, attachmentIndexing);
    const result = await svc.reindexArticle(OWNER, 99);
    expect(result.chunks).toBe(0);
    const vals = sqlValues(findFirst.mock.calls[0]?.[0]?.where);
    expect(vals).toContain(OWNER);
  });
});

describe("KbIndexingService — cross-tenant isolation", () => {
  it("indexArticle: removes chunks for an article not found in the attacker org (deny)", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const deletedWhere = jest.fn().mockResolvedValue([]);
    const makeTx = () => ({
      execute: jest.fn().mockResolvedValue(undefined),
      query: { kbPages: { findFirst } },
      delete: jest.fn().mockReturnValue({ where: deletedWhere }),
    });
    const db = {
      query: { kbPages: { findFirst } },
      delete: jest.fn().mockReturnValue({ where: deletedWhere }),
      transaction: jest.fn().mockImplementation(async (fn: (tx: ReturnType<typeof makeTx>) => unknown) => fn(makeTx())),
    } as unknown as Db;
    const embeddings = { isEmbeddingConfigured: jest.fn().mockReturnValue(false) } as never;
    const checkpoint = {} as never;
    const svc = new KbIndexingService(db, embeddings, checkpoint);
    await svc.indexArticle(ATTACKER, 42);
    expect(findFirst).toHaveBeenCalled();
    const vals = sqlValues(findFirst.mock.calls[0]?.[0]?.where);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("indexArticle: scopes to the owning org when fetching the article (control)", async () => {
    const findFirst = jest.fn().mockResolvedValue({
      status: "published",
      contentText: "hello world content for indexing",
      contentRevision: 1,
      aclRevision: 1,
    });
    const deleteWhere = jest.fn().mockResolvedValue([]);
    const makeTx = () => ({
      execute: jest.fn().mockResolvedValue(undefined),
      query: { kbPages: { findFirst } },
      delete: jest.fn().mockReturnValue({ where: deleteWhere }),
    });
    const db = {
      query: { kbPages: { findFirst } },
      delete: jest.fn().mockReturnValue({ where: deleteWhere }),
      transaction: jest.fn().mockImplementation(async (fn: (tx: ReturnType<typeof makeTx>) => unknown) => fn(makeTx())),
    } as unknown as Db;
    const embeddings = { isEmbeddingConfigured: jest.fn().mockReturnValue(false) } as never;
    const checkpoint = {} as never;
    const svc = new KbIndexingService(db, embeddings, checkpoint);
    await svc.indexArticle(OWNER, 42);
    const vals = sqlValues(findFirst.mock.calls[0]?.[0]?.where);
    expect(vals).toContain(OWNER);
    expect(vals).not.toContain(ATTACKER);
  });
});
