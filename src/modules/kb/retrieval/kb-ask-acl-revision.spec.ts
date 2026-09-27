import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import { buildAskSourceRecords } from "./kb-ask-context";
import { KbAskService } from "./kb-ask.service";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { NO_LINKED_DOCUMENTS } from "../../../test/kb-linked-document-ask-source.spec-fixtures";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();

const ACL_REVISION = 5;

const pageWithRevision = {
  kind: "page" as const,
  id: 7,
  title: "Refund Policy",
  spaceId: null,
  contentText: "We offer a 30-day refund.",
  updatedAt: new Date("2024-01-01"),
  aclRevision: ACL_REVISION,
};

const user = {
  userId: "user-acl-rev",
  orgId: "org-acl-rev",
  role: "member" as const,
  isOrgOwner: false,
  sessionId: "sess-acl-rev",
  tokenScopes: null,
  principal: humanSessionPrincipal(10, false),
};

interface InsertedRow {
  sourceIdsWithRevisions?: unknown;
  resultState?: string;
}

function buildDb() {
  const insertedRows: InsertedRow[] = [];
  const db: Record<string, unknown> = {
    execute: jest.fn().mockResolvedValue([{ one: 1 }]),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((row: InsertedRow) => {
        insertedRows.push(row);
        return Promise.resolve([]);
      }),
    })),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ id: 1 }]),
      }),
    }),
  };
  db.transaction = jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  return { db: db as unknown as Db, insertedRows };
}

function buildRetrieval(page = pageWithRevision) {
  return {
    retrieve: jest.fn().mockResolvedValue({
      documents: [page],
      sources: [],
      passages: [],
      degraded: { kind: "none" as const },
      strategy: { kind: "exact" as const },
    }),
  };
}

function buildCitations() {
  return {
    resolveCitations: jest.fn().mockResolvedValue([
      {
        kind: "page" as const,
        pageId: 7,
        title: "Refund Policy",
        spaceId: null,
        updatedAt: new Date("2024-01-01"),
      },
    ]),
    stillCitableDocuments: jest.fn().mockResolvedValue([]),
  };
}

function buildGateway() {
  return {
    invokeTextWithUsage: jest.fn().mockResolvedValue({
      ok: true,
      data: "Here is the answer.",
      correlationId: "gw-acl-rev",
      aiUsage: {
        model: "gpt-4o-mini",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        credits: 1,
        costUsd: 0.001,
      },
    }),
    isEmbeddingConfigured: jest.fn().mockReturnValue(false),
  };
}

describe("buildAskSourceRecords — ACL revision threading", () => {
  it("records the real acl_revision from a retrieved page — not null — and equals exactly the value the retrieval query returned", () => {
    const top = [{ kind: "page" as const, id: 7, aclRevision: ACL_REVISION }];
    const records = buildAskSourceRecords(top, [], []);
    expect(records[0]?.aclRevision).toBe(ACL_REVISION);
    expect(records[0]?.aclRevision).not.toBeNull();
  });

  it("records the real acl_revision from a retrieved article — not null — and equals exactly the value the retrieval query returned", () => {
    const top = [{ kind: "article" as const, id: 12, aclRevision: 3 }];
    const records = buildAskSourceRecords(top, [], []);
    expect(records[0]?.aclRevision).toBe(3);
    expect(records[0]?.aclRevision).not.toBeNull();
  });

  it("two top items with different aclRevision values each land in their own slot without cross-contamination", () => {
    const top = [
      { kind: "page" as const, id: 1, aclRevision: 2 },
      { kind: "article" as const, id: 2, aclRevision: 7 },
    ];
    const records = buildAskSourceRecords(top, [], []);
    const page = records.find((r) => r.kind === "page" && r.id === 1);
    const article = records.find((r) => r.kind === "article" && r.id === 2);
    expect(page?.aclRevision).toBe(2);
    expect(article?.aclRevision).toBe(7);
  });

  it("source kind has no acl_revision concept — kb_sources table has no acl_revision column — records null deliberately", () => {
    const records = buildAskSourceRecords([], [{ sourceId: 1 }], []);
    expect(records[0]?.aclRevision).toBeNull();
  });

  it("document (linked company document) kind has no acl_revision concept — not a kb_pages row — records null deliberately", () => {
    const records = buildAskSourceRecords([], [], [{ id: 1 }]);
    expect(records[0]?.aclRevision).toBeNull();
  });
});

describe("SQL projection — retrieveTopArticles page query projects acl_revision", () => {
  it("the page SELECT lists acl_revision by column name confirmed via queryChunks render — a star select or Column.table check would pass vacuously", async () => {
    const capturedProjections: Record<string, unknown>[] = [];
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
      innerJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      select: jest.fn((proj: Record<string, unknown>) => {
        capturedProjections.push(proj);
        return selectChain;
      }),
      execute: jest.fn().mockResolvedValue([{ count: "0" }]),
    };
    const candidates = {
      hasEmbeddedChunks: jest.fn().mockResolvedValue(false),
      articleKeywordCandidates: jest.fn().mockResolvedValue([]),
      articleVectorCandidates: jest.fn().mockResolvedValue([]),
      pageKeywordCandidates: jest.fn().mockResolvedValue([7]),
      pageVectorCandidates: jest.fn().mockResolvedValue([]),
      fuseKeys: jest.fn().mockReturnValue(["p:7"]),
      vectorChunkIds: jest.fn().mockResolvedValue([]),
    };
    const auth = {
      resolveStanding: jest.fn().mockResolvedValue({
        orgId: "org-1",
        userId: "user-1",
        membershipId: 1,
        roleSlugs: [],
        isOrgOwner: false,
        isKbAdmin: false,
        accessibleSpaceIds: [],
        accessibleProjectIds: [],
        permissionsVersion: 1,
      }),
      articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    };
    const scopes = { scopeFor: jest.fn().mockResolvedValue("all") };
    const gateway = { isEmbeddingConfigured: jest.fn().mockReturnValue(false) };

    const svc = new KbSearchRetrievalService(
      db as never,
      gateway as never,
      candidates as never,
      scopes as never,
      auth as never,
    );

    await svc.retrieveTopArticles(
      {
        userId: "user-1",
        orgId: "org-1",
        isOrgOwner: false,
        role: "member",
        sessionId: "s",
        tokenScopes: null,
        principal: humanSessionPrincipal(1, false),
      },
      "refund policy",
      4,
    );

    const pageProjection = capturedProjections.find((p) => "aclRevision" in p);
    expect(pageProjection).toBeDefined();
    const rendered = dialect.sqlToQuery(sql`${pageProjection!.aclRevision as SQL}`).sql;
    expect(rendered).toBe('"kb_pages"."acl_revision"');
    expect(rendered).not.toBe('"kb_pages"."id"');
  });
});

describe("KbAskService — acl_revision reaches the recorded interaction row", () => {
  it("the sourceIdsWithRevisions entry for a retrieved page carries the real acl_revision, not null, and equals the value the retrieval query returned", async () => {
    const { db, insertedRows } = buildDb();
    const events = { record: jest.fn().mockResolvedValue(undefined) };

    const svc = new KbAskService(
      db,
      buildGateway() as never,
      events as never,
      { aclCacheOutcome: jest.fn().mockResolvedValue("bypass") } as never,
      buildCitations() as never,
      NO_LINKED_DOCUMENTS,
      null,
      buildRetrieval() as never,
    );

    await svc.ask(user, { question: "Do you offer refunds?" });

    const row = insertedRows.find((r) => r.resultState === "answered");
    expect(row).toBeDefined();

    const sources = row?.sourceIdsWithRevisions as Array<{
      kind: string;
      id: number;
      aclRevision: number | null;
    }>;
    expect(Array.isArray(sources)).toBe(true);

    const pageEntry = sources.find((s) => s.kind === "page" && s.id === 7);
    expect(pageEntry).toBeDefined();
    expect(pageEntry?.aclRevision).toBe(ACL_REVISION);
    expect(pageEntry?.aclRevision).not.toBeNull();
  });

  it("a source kind in the same interaction records null for aclRevision because kb_sources has no acl_revision concept", async () => {
    const pageAndSource = {
      ...pageWithRevision,
    };
    const { db, insertedRows } = buildDb();
    const events = { record: jest.fn().mockResolvedValue(undefined) };

    const sourceItem = {
      sourceId: 99,
      title: "File A",
      spaceId: null,
      updatedAt: new Date("2024-01-01"),
      passages: [
        {
          documentKey: "source:99",
          documentTitle: "File A",
          passageIndex: 0,
          text: "file contents",
        },
      ],
    };

    const retrieval = {
      retrieve: jest.fn().mockResolvedValue({
        documents: [pageAndSource],
        sources: [sourceItem],
        passages: [],
        degraded: { kind: "none" as const },
        strategy: { kind: "exact" as const },
      }),
    };

    const citations = {
      resolveCitations: jest.fn().mockResolvedValue([
        {
          kind: "page" as const,
          pageId: 7,
          title: "Refund Policy",
          spaceId: null,
          updatedAt: new Date("2024-01-01"),
        },
        {
          kind: "source" as const,
          sourceId: 99,
          title: "File A",
          spaceId: null,
          updatedAt: new Date("2024-01-01"),
        },
      ]),
      stillCitableDocuments: jest.fn().mockResolvedValue([]),
    };

    const svc = new KbAskService(
      db,
      buildGateway() as never,
      events as never,
      { aclCacheOutcome: jest.fn().mockResolvedValue("bypass") } as never,
      citations as never,
      NO_LINKED_DOCUMENTS,
      null,
      retrieval as never,
    );

    await svc.ask(user, { question: "Tell me about the refund file." });

    const row = insertedRows.find((r) => r.resultState === "answered");
    expect(row).toBeDefined();

    const sources = row?.sourceIdsWithRevisions as Array<{
      kind: string;
      id: number;
      aclRevision: number | null;
    }>;

    const pageEntry = sources.find((s) => s.kind === "page" && s.id === 7);
    expect(pageEntry?.aclRevision).toBe(ACL_REVISION);
    expect(pageEntry?.aclRevision).not.toBeNull();

    const sourceEntry = sources.find((s) => s.kind === "source" && s.id === 99);
    expect(sourceEntry).toBeDefined();
    expect(sourceEntry?.aclRevision).toBeNull();
  });
});
