import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { GdprSubjectErasureService } from "./gdpr-subject-erasure.service";

jest.mock("../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../common/auth/membership-state.service", () => ({
  bustMembershipStatusCache: jest.fn().mockResolvedValue(undefined),
}));

const ORG = "org-kb";
const SUBJECT = "user-kb-subject";
const ACTOR = "user-kb-actor";

function chain(resolvedValue: unknown = []) {
  return {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(resolvedValue),
    set: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue(resolvedValue),
    values: jest.fn().mockResolvedValue(undefined),
  };
}

interface KbDbOpts {
  kbMsgDeleted?: unknown[];
  kbConvDeleted?: unknown[];
  kbPageChunkDeleted?: unknown[];
  kbArticleChunkDeleted?: unknown[];
  kbSourceChunkDeleted?: unknown[];
  authoredArticleIds?: Array<{ id: number }>;
  ownedSourceIds?: Array<{ id: number }>;
}

/**
 * Builds a mock db whose tx.delete dispatches correctly for the KB erasure path.
 *
 * The service always deletes kbArticleChunks at least once (for page-authored chunks),
 * then conditionally once more for article-authored chunks (when authoredArticleIds is
 * non-empty) and once more for source-uploaded chunks (when ownedSourceIds is non-empty).
 * The round-robin here mirrors that same conditional to stay in sync.
 */
function makeKbDb(opts: KbDbOpts = {}) {
  const {
    kbMsgDeleted = [],
    kbConvDeleted = [],
    kbPageChunkDeleted = [],
    kbArticleChunkDeleted = [],
    kbSourceChunkDeleted = [],
    authoredArticleIds = [],
    ownedSourceIds = [],
  } = opts;

  const kbMsgDeleteChain = chain(kbMsgDeleted);
  const kbConvDeleteChain = chain(kbConvDeleted);

  // Mirror the service's conditional: page is always first, then article (if any),
  // then source (if any). This matches the exact call order the service produces.
  const kbChunkChains: ReturnType<typeof chain>[] = [chain(kbPageChunkDeleted)];
  if (authoredArticleIds.length > 0) kbChunkChains.push(chain(kbArticleChunkDeleted));
  if (ownedSourceIds.length > 0) kbChunkChains.push(chain(kbSourceChunkDeleted));

  let txDeleteCount = 0;
  let kbChunkCallIdx = 0;
  let txSelectCount = 0;

  const tx = {
    select: jest.fn().mockImplementation(() => {
      txSelectCount++;
      if (txSelectCount === 1) return chain([{ id: 10 }]);
      if (txSelectCount === 2) return chain([{ id: 20 }]);
      if (txSelectCount === 3) return chain([]);
      if (txSelectCount === 4) return chain(authoredArticleIds);
      if (txSelectCount === 5) return chain(ownedSourceIds);
      return chain([]);
    }),
    update: jest.fn().mockReturnValue(chain([{ id: 99 }])),
    insert: jest.fn().mockReturnValue(chain([])),
    delete: jest.fn().mockImplementation(() => {
      txDeleteCount++;
      if (txDeleteCount === 1) return kbMsgDeleteChain;
      if (txDeleteCount === 2) return kbConvDeleteChain;
      const c = kbChunkChains[kbChunkCallIdx++];
      return c ?? chain([]);
    }),
  };

  const db = {
    select: jest.fn().mockImplementation(
      (() => {
        let dbSelectCount = 0;
        return () => {
          dbSelectCount++;
          if (dbSelectCount === 1) return chain([{ id: 1 }]);
          return chain([]);
        };
      })(),
    ),
    update: jest.fn().mockReturnValue(chain([])),
    insert: jest.fn().mockReturnValue(chain([])),
    transaction: jest.fn().mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    ),
  };

  return {
    db,
    tx,
    chains: { kbMsgDeleteChain, kbConvDeleteChain, kbChunkChains },
  };
}

function buildService(db: ReturnType<typeof makeKbDb>["db"]): GdprSubjectErasureService {
  const cache = {} as CacheService;
  return new GdprSubjectErasureService(db as unknown as Db, cache);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── KB chat message hard-deletion ───────────────────────────────────────────

describe("GdprSubjectErasureService — kb_chat_messages hard-deletion", () => {
  it("includes kb_chat_messages in tablesAnonymised when the delete removes rows", async () => {
    const { db } = makeKbDb({ kbMsgDeleted: [{ id: 1 }, { id: 2 }] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).toContain("kb_chat_messages");
  });

  it("calls tx.delete at least once for KB chat messages", async () => {
    const { db, tx } = makeKbDb({ kbMsgDeleted: [{ id: 3 }] });
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(tx.delete).toHaveBeenCalled();
    expect(tx.delete.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("(bite proof) kb_chat_messages absent from tablesAnonymised when delete returns no rows", async () => {
    // Mechanism: kbMsgDeleted = [] → returning([]) → NOT pushed to tablesAnonymised.
    // Neuter the primary test: swap kbMsgDeleted to [{ id: 1 }] → IS pushed →
    // "not.toContain" assertion FAILS — the test catches a missing erasure.
    const { db } = makeKbDb({ kbMsgDeleted: [] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).not.toContain("kb_chat_messages");
  });
});

// ─── KB chat conversation hard-deletion ──────────────────────────────────────

describe("GdprSubjectErasureService — kb_chat_conversations hard-deletion", () => {
  it("includes kb_chat_conversations in tablesAnonymised when the delete removes rows", async () => {
    const { db } = makeKbDb({ kbConvDeleted: [{ id: 5 }] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).toContain("kb_chat_conversations");
  });

  it("tx.delete call 1 is messages, call 2 is conversations (FK children before parents)", async () => {
    // The service deletes kb_chat_messages first, then kb_chat_conversations.
    // Both are unconditional; position in the call sequence is fixed.
    // Both having rows means both appear in tablesAnonymised, and the order reflects deletion order.
    const { db } = makeKbDb({ kbMsgDeleted: [{ id: 1 }], kbConvDeleted: [{ id: 5 }] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised.indexOf("kb_chat_messages")).toBeLessThan(
      result.tablesAnonymised.indexOf("kb_chat_conversations"),
    );
  });

  it("(bite proof) kb_chat_conversations absent from tablesAnonymised when delete returns no rows", async () => {
    const { db } = makeKbDb({ kbConvDeleted: [] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).not.toContain("kb_chat_conversations");
  });
});

// ─── KB article chunks (page-authored) ───────────────────────────────────────

describe("GdprSubjectErasureService — kb_article_chunks from pages", () => {
  it("includes kb_article_chunks in tablesAnonymised when page-derived chunks are deleted", async () => {
    const { db } = makeKbDb({ kbPageChunkDeleted: [{ id: 100 }] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).toContain("kb_article_chunks");
  });

  it("tx.delete is called at least 3 times (messages, conversations, page-chunks)", async () => {
    const { db, tx } = makeKbDb({ kbPageChunkDeleted: [{ id: 100 }] });
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(tx.delete.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("(bite proof) kb_article_chunks absent from tablesAnonymised when no page chunks are deleted", async () => {
    // Mechanism: kbPageChunkDeleted = [] → returning([]) → NOT pushed.
    // Neuter: swap to [{ id: 1 }] → IS pushed → "not.toContain" FAILS.
    const { db } = makeKbDb({ kbPageChunkDeleted: [] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).not.toContain("kb_article_chunks");
  });
});

// ─── KB article chunks (article-authored) ────────────────────────────────────

describe("GdprSubjectErasureService — kb_article_chunks from articles", () => {
  it("deletes article chunks when the subject has authored articles", async () => {
    const { db } = makeKbDb({
      authoredArticleIds: [{ id: 7 }],
      kbArticleChunkDeleted: [{ id: 200 }],
    });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).toContain("kb_article_chunks");
  });

  it("skips the article chunk delete when the subject has authored no articles", async () => {
    // No articles → only 3 delete calls: messages, conversations, page-chunks.
    // With articles → 4 delete calls (article chunks added).
    const { db, tx } = makeKbDb({ authoredArticleIds: [] });
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(tx.delete.mock.calls.length).toBe(3);
  });

  it("(bite proof) kb_article_chunks absent when article chunk delete returns no rows and no page chunks", async () => {
    const { db } = makeKbDb({
      authoredArticleIds: [{ id: 7 }],
      kbArticleChunkDeleted: [],
    });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).not.toContain("kb_article_chunks");
  });
});

// ─── KB article chunks (source-uploaded) ─────────────────────────────────────

describe("GdprSubjectErasureService — kb_article_chunks from sources", () => {
  it("deletes source chunks when the subject has uploaded sources", async () => {
    const { db } = makeKbDb({
      ownedSourceIds: [{ id: 3 }],
      kbSourceChunkDeleted: [{ id: 300 }],
    });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).toContain("kb_article_chunks");
  });

  it("skips the source chunk delete when the subject owns no sources", async () => {
    // No sources → only 3 delete calls: messages, conversations, page-chunks.
    const { db, tx } = makeKbDb({ ownedSourceIds: [] });
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(tx.delete.mock.calls.length).toBe(3);
  });

  it("(bite proof) kb_article_chunks absent when source chunk delete returns no rows and no page chunks", async () => {
    const { db } = makeKbDb({
      ownedSourceIds: [{ id: 3 }],
      kbSourceChunkDeleted: [],
    });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).not.toContain("kb_article_chunks");
  });
});

// ─── Dry-run includes KB tables ───────────────────────────────────────────────

describe("GdprSubjectErasureService — dry-run KB preview", () => {
  it("dry-run includes kb_chat_messages, kb_chat_conversations, kb_article_chunks without writes", async () => {
    const { db } = makeKbDb();
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.tablesAnonymised).toContain("kb_chat_messages");
    expect(result.tablesAnonymised).toContain("kb_chat_conversations");
    expect(result.tablesAnonymised).toContain("kb_article_chunks");
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("GdprSubjectErasureService — KB erasure idempotency", () => {
  it("second run with no KB rows to delete does not error and returns success", async () => {
    const { db } = makeKbDb({
      kbMsgDeleted: [],
      kbConvDeleted: [],
      kbPageChunkDeleted: [],
    });
    const svc = buildService(db);

    await expect(
      svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false }),
    ).resolves.toMatchObject({ blocked: false, dryRun: false });
  });
});
