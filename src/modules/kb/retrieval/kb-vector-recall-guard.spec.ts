/**
 * The regression guard for the recall defect measured 2026-09-09 on a 49,000-chunk,
 * 4-tenant corpus: `vectorChunkIds` used to return the ANN pool whenever it was full
 * (`annIds.length >= cap`). Every HNSW-planned cell in that measurement returned exactly
 * `cap` rows AND lost 3-56% of the true top-k, so the count could never fire the fallback
 * and recall was lost silently at full cardinality.
 *
 * These tests pin the replacement: the strategy is decided from the tenant's indexed
 * chunk count and the cap BEFORE any vector query runs, and a full ANN pool decides
 * nothing. Queries are asserted on rendered SQL (`PgDialect`), never on the shape of a
 * drizzle condition object; a mock still cannot measure recall — `kb-vector-recall.db.spec.ts`
 * does that against a real HNSW index — but it can pin which query is issued and why.
 */
import { Test } from "@nestjs/testing";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { CacheService } from "../../../common/cache/cache.service";
import { KbCandidateService } from "./kb-candidate.service";
import { KB_EXACT_SCAN_MAX_CHUNKS } from "./kb-retrieval-strategy";
import { DRIZZLE } from "../../../db/drizzle.constants";

const ORG = "org-recall";
const VECTOR = "[0.1,0.2]";
const CAP = 24;
const SMALL_TENANT = 780;
const LARGE_TENANT = 39_700;

const dialect = new PgDialect();

interface Rendered {
  sql: string;
  params: unknown[];
}

const ids = (from: number, count: number): { id: number }[] =>
  Array.from({ length: count }, (_, i) => ({ id: from + i }));

const isCount = (q: Rendered): boolean => q.sql.includes("chunk_count");
const isAnn = (q: Rendered): boolean => q.sql.includes("ORDER BY embedding <=>");
const isExact = (q: Rendered): boolean => q.sql.includes("OFFSET") && q.sql.includes("scoped");

function makeDb(chunkCount: number, annRows: number, exactRows: number) {
  const rendered: Rendered[] = [];
  const execute = jest.fn((node: SQL) => {
    const query = dialect.sqlToQuery(node);
    rendered.push(query);
    if (isCount(query)) return Promise.resolve([{ chunk_count: chunkCount }]);
    if (isExact(query)) return Promise.resolve(ids(900, exactRows));
    if (isAnn(query)) return Promise.resolve(ids(500, annRows));
    return Promise.resolve([]);
  });
  return { db: { execute }, rendered };
}

describe("a full ANN pool no longer decides anything — the deleted heuristic", () => {
  it("a small tenant scans exactly EVEN WHEN the ANN pass would have returned a full pool", async () => {
    const { db, rendered } = makeDb(SMALL_TENANT, CAP, CAP);
    const service = new KbCandidateService(db as never);

    const result = await service.vectorChunkIds(ORG, VECTOR, CAP);

    expect(rendered.filter(isAnn)).toHaveLength(0);
    expect(rendered.filter(isExact)).toHaveLength(1);
    expect(result).toEqual(ids(900, CAP).map((row) => row.id));
  });

  it("a large tenant uses ANN EVEN WHEN the ANN pass comes back short — a short pool is not a strategy signal either", async () => {
    const { db, rendered } = makeDb(LARGE_TENANT, 3, CAP);
    const service = new KbCandidateService(db as never);

    const result = await service.vectorChunkIds(ORG, VECTOR, CAP);

    expect(rendered.filter(isExact)).toHaveLength(0);
    expect(result).toEqual([500, 501, 502]);
  });

  it("the choice follows tenant size alone: identical row fixtures, opposite queries", async () => {
    const small = makeDb(KB_EXACT_SCAN_MAX_CHUNKS, CAP, CAP);
    const large = makeDb(KB_EXACT_SCAN_MAX_CHUNKS + 1, CAP, CAP);

    await new KbCandidateService(small.db as never).vectorChunkIds(ORG, VECTOR, CAP);
    await new KbCandidateService(large.db as never).vectorChunkIds(ORG, VECTOR, CAP);

    expect(small.rendered.some(isExact)).toBe(true);
    expect(small.rendered.some(isAnn)).toBe(false);
    expect(large.rendered.some(isAnn)).toBe(true);
    expect(large.rendered.some(isExact)).toBe(false);
  });

  it("the count that decides it is read before either vector query is issued", async () => {
    const { db, rendered } = makeDb(LARGE_TENANT, CAP, CAP);
    const service = new KbCandidateService(db as never);

    await service.vectorChunkIds(ORG, VECTOR, CAP);

    expect(rendered.findIndex(isCount)).toBeLessThan(rendered.findIndex(isAnn));
  });

  it("an empty ANN result does not trigger an exact scan for a large tenant", async () => {
    const { db, rendered } = makeDb(LARGE_TENANT, 0, CAP);
    const module = await Test.createTestingModule({
      providers: [KbCandidateService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    try {
      const result = await module.get(KbCandidateService).vectorChunkIds(ORG, VECTOR, CAP);
      expect(result).toEqual([]);
      expect(rendered.filter(isAnn)).toHaveLength(1);
      expect(rendered.filter(isExact)).toHaveLength(0);
    } finally {
      await module.close();
    }
  });
});

describe("the ANN branch raises ef_search instead of leaving it at the pgvector default", () => {
  it("sets hnsw.ef_search to at least the cap before the ANN query", async () => {
    const { db, rendered } = makeDb(LARGE_TENANT, CAP, CAP);
    const service = new KbCandidateService(db as never);

    await service.vectorChunkIds(ORG, VECTOR, CAP);

    const efSearch = rendered.find((q) => q.sql.includes("hnsw.ef_search"));
    expect(efSearch).toBeDefined();
    const value = Number(/hnsw\.ef_search\s*=\s*(\d+)/.exec(efSearch?.sql ?? "")?.[1] ?? 0);
    expect(value).toBeGreaterThanOrEqual(CAP);
    expect(rendered.findIndex((q) => q.sql.includes("hnsw.ef_search"))).toBeLessThan(
      rendered.findIndex(isAnn),
    );
  });

  it("the exact branch does not raise ef_search — it is not running an index scan", async () => {
    const { db, rendered } = makeDb(SMALL_TENANT, CAP, CAP);
    await new KbCandidateService(db as never).vectorChunkIds(ORG, VECTOR, CAP);
    expect(rendered.some((q) => q.sql.includes("hnsw.ef_search"))).toBe(false);
  });
});

describe("the invariants the previous spec pinned, which still hold", () => {
  it("SET LOCAL hnsw.iterative_scan = relaxed_order is the first statement on both branches", async () => {
    for (const chunkCount of [SMALL_TENANT, LARGE_TENANT]) {
      const { db, rendered } = makeDb(chunkCount, CAP, CAP);
      await new KbCandidateService(db as never).vectorChunkIds(ORG, VECTOR, CAP);
      expect(rendered[0]?.sql).toContain("SET LOCAL hnsw.iterative_scan = relaxed_order");
      const vectorAt = rendered.findIndex((q) => q.sql.includes("::vector"));
      expect(vectorAt).toBeGreaterThan(0);
    }
  });

  it("the exact branch keeps the OFFSET 0 fence so the planner cannot push the sort into the index", async () => {
    const { db, rendered } = makeDb(SMALL_TENANT, CAP, CAP);
    await new KbCandidateService(db as never).vectorChunkIds(ORG, VECTOR, CAP);
    const exact = rendered.find(isExact);
    expect(exact?.sql).toContain("OFFSET 0");
    expect(exact?.sql).toContain("ORDER BY scoped.distance");
  });

  it("every statement that touches the table binds the caller's org as a parameter", async () => {
    const { db, rendered } = makeDb(LARGE_TENANT, CAP, CAP);
    await new KbCandidateService(db as never).vectorChunkIds(ORG, VECTOR, CAP);

    const scoped = rendered.filter((q) => q.sql.includes("kb_article_chunks"));
    expect(scoped.length).toBeGreaterThan(1);
    for (const query of scoped) {
      expect(query.sql).toContain("org_id = $");
      expect(query.params).toContain(ORG);
    }
  });

  it("the tenant bound follows the argument rather than being a constant that happens to match", async () => {
    const { db, rendered } = makeDb(LARGE_TENANT, CAP, CAP);
    await new KbCandidateService(db as never).vectorChunkIds("org-other", VECTOR, CAP);
    for (const query of rendered.filter((q) => q.sql.includes("kb_article_chunks")))
      expect(query.params).not.toContain(ORG);
  });

  it("a non-positive cap short-circuits before any statement is issued", async () => {
    const { db } = makeDb(LARGE_TENANT, CAP, CAP);
    const service = new KbCandidateService(db as never);
    expect(await service.vectorChunkIds(ORG, VECTOR, 0)).toEqual([]);
    expect(await service.vectorChunkIds(ORG, VECTOR, -1)).toEqual([]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("the bounded count is bounded — it never issues an unbounded COUNT(*)", async () => {
    const { db, rendered } = makeDb(LARGE_TENANT, CAP, CAP);
    await new KbCandidateService(db as never).vectorChunkIds(ORG, VECTOR, CAP);
    const count = rendered.find(isCount);
    expect(count?.sql).toContain("LIMIT $");
    expect(count?.params).toContain(KB_EXACT_SCAN_MAX_CHUNKS + 1);
  });
});

describe("the count is cached under a key that carries the tenant", () => {
  it("passes orgId and an org-bearing key to the cache, and still answers", async () => {
    const { db, rendered } = makeDb(LARGE_TENANT, CAP, CAP);
    const cache = new CacheService(null, 3_000);
    const spy = jest.spyOn(cache, "cachedForOrg");

    const result = await new KbCandidateService(db as never, cache).vectorChunkIds(
      ORG,
      VECTOR,
      CAP,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [orgArg, keyArg] = spy.mock.calls[0] ?? [];
    expect(orgArg).toBe(ORG);
    expect(String(keyArg)).toContain(ORG);
    expect(rendered.some(isCount)).toBe(true);
    expect(result).toEqual(ids(500, CAP).map((row) => row.id));
  });

  it("without a cache it reads the count directly rather than assuming a size", async () => {
    const { db, rendered } = makeDb(SMALL_TENANT, CAP, CAP);
    await new KbCandidateService(db as never).vectorChunkIds(ORG, VECTOR, CAP);
    expect(rendered.filter(isCount)).toHaveLength(1);
  });
});

describe("the rendering harness itself bites", () => {
  it("PgDialect renders a bound parameter as a placeholder, so a text-only match cannot pass on another org", () => {
    const rendered = dialect.sqlToQuery(sql`SELECT 1 FROM t WHERE org_id = ${ORG}`);
    expect(rendered.sql).toContain("org_id = $1");
    expect(rendered.params).toEqual([ORG]);
  });
});
