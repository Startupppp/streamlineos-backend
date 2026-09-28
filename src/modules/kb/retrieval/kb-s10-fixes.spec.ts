jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import { KbArticleReindexService } from "./kb-article-reindex.service";
import { KbAttachmentIndexingService } from "./kb-attachment-indexing.service";
import { KbChatHistoryService } from "./kb-chat-history.service";
import type { KbAskCitationService } from "./kb-ask-citations.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const makeScopes = (scope = "all") => ({ scopeFor: jest.fn().mockResolvedValue(scope) });

const makeCheckpointStub = () =>
  ({
    loadCheckpoints: jest.fn().mockResolvedValue(new Map<number, number[]>()),
    saveCheckpoints: jest.fn().mockResolvedValue(undefined),
    clearCheckpoints: jest.fn().mockResolvedValue(undefined),
  }) as never;

jest.mock("../../../common/documents/extract-document-text.util", () => ({
  isExtractableMime: jest.fn().mockReturnValue(true),
  extractDocumentText: jest.fn().mockResolvedValue(""),
}));

const extractMocks = jest.requireMock("../../../common/documents/extract-document-text.util") as {
  isExtractableMime: jest.Mock;
  extractDocumentText: jest.Mock;
};

function collectStrings(root: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof root === "string") return [root];
  if (root === null || typeof root !== "object") return [];
  if (seen.has(root)) return [];
  seen.add(root);
  return Object.values(root).flatMap((v) => collectStrings(v, seen));
}

function sqlToQuery(cond: unknown): { sql: string; params: unknown[] } {
  const dialect = new PgDialect();
  return dialect.sqlToQuery(cond as SQL);
}

describe("Fix 1 — retrieveTopSources carries chunk-side orgId predicate", () => {
  it("WHERE clause includes an org_id = orgId predicate scoped to kbArticleChunks", async () => {
    const capturedConditions: unknown[] = [];
    const chain: Record<string, jest.Mock> = {
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn((cond: unknown) => {
        capturedConditions.push(cond);
        return chain;
      }),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ id: 1 }]),
    };
    const db = {
      select: jest.fn().mockReturnValue(chain),
      execute: jest.fn().mockResolvedValue([]),
    };
    const embeddings = {
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
      embedQueryWithCredit: jest.fn().mockResolvedValue({ ok: true, vector: [0.1], vectorLiteral: "[0.1]" }),
    };
    const auth = {
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
      articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
      resolveStanding: jest.fn().mockResolvedValue({
        orgId: "org-fix1",
        userId: "u1",
        membershipId: 1,
        roleSlugs: [],
        isOrgOwner: false,
        isKbAdmin: false,
        accessibleSpaceIds: [1],
        accessibleProjectIds: [],
        permissionsVersion: 1,
      }),
      assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
    };
    const candidates = {
      hasEmbeddedChunks: jest.fn().mockResolvedValue(true),
      vectorChunkIds: jest.fn().mockResolvedValue([1]),
    };
    const svc = new KbSearchRetrievalService(
      db as never,
      embeddings as never,
      candidates as never,
      {} as never,
      auth as never,
    );

    await svc.retrieveTopSources({ userId: "u1", orgId: "org-fix1", isOrgOwner: false, role: "member", sessionId: "s1", tokenScopes: null, principal: undefined } as never, "query", 4, undefined, { vectorLiteral: "[0.1]" });

    expect(capturedConditions.length).toBeGreaterThan(0);

    const chunkOrgIdPredicates = capturedConditions.flatMap((cond) => {
      const { sql: text, params } = sqlToQuery(cond);
      const matches: Array<{ text: string; params: unknown[] }> = [];
      const re = /"kb_article_chunks"\."org_id"\s*=\s*\$(\d+)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null)
        matches.push({ text, params });
      return matches;
    });

    expect(chunkOrgIdPredicates.length).toBeGreaterThan(0);
    for (const { text, params } of chunkOrgIdPredicates) {
      const slot = /"kb_article_chunks"\."org_id"\s*=\s*\$(\d+)/i.exec(text);
      expect(params[Number(slot?.[1]) - 1]).toBe("org-fix1");
    }
  });
});

describe("Fix 2 — reindexAll uses keyset pagination", () => {
  function makeThenable(rows: unknown[]) {
    const p = Promise.resolve(rows);
    const chain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(rows),
      groupBy: jest.fn().mockReturnThis(),
      then: p.then.bind(p),
      catch: p.catch.bind(p),
      finally: p.finally.bind(p),
    };
    return chain;
  }

  function makeDb(articleRows: unknown[], countRow: unknown[] = [{ chunks: 0 }]) {
    let selectCall = 0;
    return {
      select: jest.fn(() => makeThenable(selectCall++ === 0 ? articleRows : countRow)),
    } as unknown as Db;
  }

  it("returns nextArticleId when batch overflows", async () => {
    const firstBatch = Array.from({ length: 101 }, (_, i) => ({ id: i + 1 }));
    const db = makeDb(firstBatch);
    const svc = new KbArticleReindexService(db, {} as never, {} as never);
    svc.reindexArticle = jest.fn().mockResolvedValue({ chunks: 0, warnings: [] });

    const result = await svc.reindexAll("org-1");
    expect(result.total).toBe(100);
    expect(result.nextArticleId).toBe(100);
  });

  it("returns nextArticleId: null when fewer articles than batch size", async () => {
    const fewArticles = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
    const db = makeDb(fewArticles);
    const svc = new KbArticleReindexService(db, {} as never, {} as never);
    svc.reindexArticle = jest.fn().mockResolvedValue({ chunks: 0, warnings: [] });

    const result = await svc.reindexAll("org-1");
    expect(result.nextArticleId).toBeNull();
    expect(result.total).toBe(5);
  });

  it("resumes from cursor on second call (nextArticleId: null at end)", async () => {
    const overflowBatch = Array.from({ length: 101 }, (_, i) => ({ id: i + 1 }));
    const db1 = makeDb(overflowBatch);
    const svc1 = new KbArticleReindexService(db1, {} as never, {} as never);
    svc1.reindexArticle = jest.fn().mockResolvedValue({ chunks: 0, warnings: [] });
    const first = await svc1.reindexAll("org-1");
    expect(first.nextArticleId).toBe(100);

    const remainingBatch = [{ id: 101 }];
    const db2 = makeDb(remainingBatch);
    const svc2 = new KbArticleReindexService(db2, {} as never, {} as never);
    svc2.reindexArticle = jest.fn().mockResolvedValue({ chunks: 0, warnings: [] });
    const second = await svc2.reindexAll("org-1", first.nextArticleId ?? 0);
    expect(second.nextArticleId).toBeNull();
    expect(second.total).toBe(1);
  });

  it("requests BATCH_SIZE + 1 rows to detect overflow", async () => {
    const limits: number[] = [];
    let selectCall = 0;
    const db = {
      select: jest.fn(() => {
        const p = selectCall++ === 0 ? Promise.resolve([]) : Promise.resolve([{ chunks: 0 }]);
        return {
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn((n: number) => { limits.push(n); return p; }),
          then: (p as Promise<unknown>).then.bind(p),
          catch: (p as Promise<unknown>).catch.bind(p),
          finally: (p as Promise<unknown>).finally.bind(p),
        };
      }),
    } as unknown as Db;

    const svc = new KbArticleReindexService(db, {} as never, {} as never);
    await svc.reindexAll("org-1");
    expect(limits[0]).toBe(101);
  });
});

describe("Fix 3 — embedInBatches: batched calls, order preserved across boundary", () => {
  it("makes one credited gateway batch call for the whole document and preserves chunk order", async () => {
    const CHUNKS_COUNT = 65;
    const text = "word ".repeat(20000);

    const capturedInsertValues: Array<Array<{ chunkIndex: number; embedding: number[] }>> = [];
    const embedBatchWithCredit = jest.fn().mockImplementation(({ texts }: { texts: string[] }) =>
      Promise.resolve({ ok: true, vectors: texts.map((_, i) => [i]) }),
    );
    const embedQueryWithCredit = jest.fn();

    const deleteWhere = jest.fn().mockResolvedValue([]);
    const insertValues = jest.fn().mockImplementation((vals: unknown) => {
      capturedInsertValues.push(vals as Array<{ chunkIndex: number; embedding: number[] }>);
      return Promise.resolve([]);
    });
    const tx = {
      delete: jest.fn().mockReturnValue({ where: deleteWhere }),
      insert: jest.fn().mockReturnValue({ values: insertValues }),
    };
    const emptyChunkState = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ contentHash: null, aclRevision: null, chunkCount: 0 }]),
      }),
    });
    const db = {
      transaction: jest.fn().mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      select: emptyChunkState,
      query: {
        kbPageAttachments: { findFirst: jest.fn() },
      },
    } as unknown as Db;

    extractMocks.extractDocumentText.mockResolvedValue(text);
    extractMocks.isExtractableMime.mockReturnValue(true);

    const storage = { getFileStream: jest.fn().mockResolvedValue({ body: {} }) } as never;
    const gateway = {
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
      embedBatchWithCredit,
      embedQueryWithCredit,
    } as never;
    const svc = new KbAttachmentIndexingService(db, gateway, storage, makeCheckpointStub());

    await svc.indexSource("org-1", 1, text);

    expect(embedQueryWithCredit).not.toHaveBeenCalled();
    expect(embedBatchWithCredit).toHaveBeenCalledTimes(1);
    expect(embedBatchWithCredit).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", feature: "kb.indexing", charge: true }),
    );
    const batchCall = embedBatchWithCredit.mock.calls[0]?.[0] as { texts: string[] };
    expect(batchCall.texts.length).toBeGreaterThanOrEqual(CHUNKS_COUNT);

    const rows = capturedInsertValues[0];
    if (rows && rows.length >= 65) {
      expect(rows[63]?.embedding).toEqual([63]);
      expect(rows[64]?.embedding).toEqual([64]);
    } else if (rows) {
      const lastIdx = rows.length - 1;
      expect(rows[lastIdx]?.embedding).toEqual([lastIdx]);
    }
    expect(rows?.length).toBeGreaterThan(0);
  });
});

describe("Fix 4 — indexPageDocument: delete-before-insert in transaction, dead ACL columns absent so chunkVisibleTo remains the sole ACL predicate", () => {
  it("runs delete and insert inside one transaction and omits pageVisibility, pageCreatedById, pageCreatedByMembershipId from every inserted row", async () => {
    const callOrder: string[] = [];
    const deleteWhere = jest.fn().mockImplementation(() => { callOrder.push("delete"); return Promise.resolve([]); });
    const capturedInsertValues: unknown[] = [];
    const insertValues = jest.fn().mockImplementation((vals: unknown) => {
      callOrder.push("insert");
      capturedInsertValues.push(vals);
      return Promise.resolve([]);
    });
    const tx = {
      delete: jest.fn().mockReturnValue({ where: deleteWhere }),
      insert: jest.fn().mockReturnValue({ values: insertValues }),
    };
    const pageRow = { aclRevision: 3 };
    const db = {
      transaction: jest.fn().mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ contentHash: null, aclRevision: null, chunkCount: 0 }]),
        }),
      }),
      query: {
        kbPages: { findFirst: jest.fn().mockResolvedValue(pageRow) },
      },
    } as unknown as Db;

    const shortText = "hello world sentence";
    extractMocks.extractDocumentText.mockResolvedValue(shortText);
    extractMocks.isExtractableMime.mockReturnValue(true);

    const embedBatchWithCredit = jest.fn().mockImplementation(({ texts }: { texts: string[] }) =>
      Promise.resolve({ ok: true, vectors: texts.map(() => [0.5]) }),
    );
    const gateway = {
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
      embedBatchWithCredit,
    } as never;

    const svc = new KbAttachmentIndexingService(db, gateway, {} as never, makeCheckpointStub());
    const result = await svc.indexPageDocument("org-1", 7, Buffer.from("pdf"), "application/pdf", "doc.pdf");

    expect(result.chunks).toBeGreaterThan(0);
    expect(db.transaction).toHaveBeenCalled();
    expect(callOrder).toEqual(["delete", "insert"]);

    const rows = capturedInsertValues[0] as Array<Record<string, unknown>>;
    expect(rows).toBeDefined();
    expect(rows[0]).not.toHaveProperty("pageVisibility");
    expect(rows[0]).not.toHaveProperty("pageCreatedById");
    expect(rows[0]).not.toHaveProperty("pageCreatedByMembershipId");
    expect(rows[0]?.["aclRevision"]).toBe(3);
  });

  it("does not insert when page is not found for the given orgId", async () => {
    const db = {
      transaction: jest.fn(),
      query: {
        kbPages: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    } as unknown as Db;

    extractMocks.isExtractableMime.mockReturnValue(true);

    const embeddings = { isEmbeddingConfigured: jest.fn().mockReturnValue(true) } as never;
    const svc = new KbAttachmentIndexingService(db, embeddings, {} as never, makeCheckpointStub());
    const result = await svc.indexPageDocument("org-1", 99, Buffer.from(""), "application/pdf", "f.pdf");

    expect(result.chunks).toBe(0);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("Fix 5 — listConversations cursor is tenant-scoped", () => {
  function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
    if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
    if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
    if (typeof v !== "object" || seen.has(v)) return [];
    seen.add(v);
    const r = v as { queryChunks?: unknown[]; value?: unknown };
    return [
      ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
      ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
    ];
  }

  it("cursor resolution query carries orgId and membershipId predicates", async () => {
    const capturedWheres: unknown[] = [];

    const makeChain = () => {
      const chain: Record<string, jest.Mock> = {
        where: jest.fn((w: unknown) => { capturedWheres.push(w); return chain; }),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      };
      return chain;
    };

    const db = {
      select: jest.fn(() => ({ from: jest.fn(() => makeChain()) })),
    } as unknown as Db;

    const citationFilter: KbAskCitationService = { filterStoredCitations: jest.fn().mockResolvedValue([]) } as unknown as KbAskCitationService;
    const user: CurrentUserContext = { userId: "user-1", orgId: "org-cursor", role: "member", isOrgOwner: false, sessionId: "s", tokenScopes: null, principal: humanSessionPrincipal(55, false) };
    const svc = new KbChatHistoryService(db, citationFilter);
    await svc.listConversations(user, { cursor: 42, limit: 10 });

    expect(capturedWheres.length).toBeGreaterThan(0);

    const allValues = capturedWheres.flatMap((w) => sqlValues(w));
    expect(allValues).toContain("org-cursor");
    expect(allValues).toContain(55);
    expect(allValues).not.toContain("org-other");

    const cursorWhere = capturedWheres[0];
    const cursorVals = sqlValues(cursorWhere);
    expect(cursorVals).toContain(42);
    expect(cursorVals).toContain("org-cursor");
    expect(cursorVals).toContain(55);
  });

  it("without cursor the list query still carries orgId and membershipId (control)", async () => {
    const capturedWheres: unknown[] = [];

    const makeChain = () => {
      const chain: Record<string, jest.Mock> = {
        where: jest.fn((w: unknown) => { capturedWheres.push(w); return chain; }),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      };
      return chain;
    };

    const db = {
      select: jest.fn(() => ({ from: jest.fn(() => makeChain()) })),
    } as unknown as Db;

    const citationFilter: KbAskCitationService = { filterStoredCitations: jest.fn().mockResolvedValue([]) } as unknown as KbAskCitationService;
    const user: CurrentUserContext = { userId: "user-1", orgId: "org-control", role: "member", isOrgOwner: false, sessionId: "s", tokenScopes: null, principal: humanSessionPrincipal(77, false) };
    const svc = new KbChatHistoryService(db, citationFilter);
    await svc.listConversations(user, { limit: 10 });

    const allValues = capturedWheres.flatMap((w) => sqlValues(w));
    expect(allValues).toContain("org-control");
    expect(allValues).toContain(77);
  });
});
