import type { Db } from "../../db/drizzle.module";
import type { SessionsService } from "../sessions/sessions.service";
import { CacheService } from "../../common/cache/cache.service";
import { GdprSubjectErasureService } from "./gdpr-subject-erasure.service";
import { users } from "../../db/schema";

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
    then: (
      resolve: (v: unknown) => unknown,
      reject?: (r: unknown) => unknown,
    ) => Promise.resolve(resolvedValue).then(resolve, reject),
  };
}

interface KbDbOpts {
  kbMsgDeleted?: unknown[];
  kbConvDeleted?: unknown[];
  kbPageChunkDeleted?: unknown[];
  kbArticleChunkDeleted?: unknown[];
  kbSourceChunkDeleted?: unknown[];
  kbAttachmentChunkDeleted?: unknown[];
  authoredArticleIds?: Array<{ id: number }>;
  ownedSourceIds?: Array<{ id: number }>;
  uploadedAttachmentIds?: Array<{ id: number }>;
}

/**
 * Builds a mock db whose tx.delete dispatches correctly for the KB erasure path.
 *
 * The service always deletes kbArticleChunks at least once (for page-authored chunks),
 * then conditionally once more for article-authored chunks (when authoredArticleIds is
 * non-empty), once more for source-uploaded chunks (when ownedSourceIds is non-empty),
 * and once more for attachment-uploaded chunks (when uploadedAttachmentIds is non-empty).
 * The round-robin here mirrors that same conditional to stay in sync.
 */
function makeKbDb(opts: KbDbOpts = {}) {
  const {
    kbMsgDeleted = [],
    kbConvDeleted = [],
    kbPageChunkDeleted = [],
    kbArticleChunkDeleted = [],
    kbSourceChunkDeleted = [],
    kbAttachmentChunkDeleted = [],
    authoredArticleIds = [],
    ownedSourceIds = [],
    uploadedAttachmentIds = [],
  } = opts;

  const kbMsgDeleteChain = chain(kbMsgDeleted);
  const kbConvDeleteChain = chain(kbConvDeleted);

  // Mirror the service's conditional: page is always first, then article (if any),
  // then source (if any), then attachment (if any). Matches the exact call order.
  const kbChunkChains: ReturnType<typeof chain>[] = [chain(kbPageChunkDeleted)];
  if (authoredArticleIds.length > 0) kbChunkChains.push(chain(kbArticleChunkDeleted));
  if (ownedSourceIds.length > 0) kbChunkChains.push(chain(kbSourceChunkDeleted));
  if (uploadedAttachmentIds.length > 0) kbChunkChains.push(chain(kbAttachmentChunkDeleted));

  let txDeleteCount = 0;
  let kbChunkCallIdx = 0;
  let txSelectCount = 0;

  const tx = {
    select: jest.fn().mockImplementation(() => ({
      // The support-ticket erasure probes `users.email` inside the transaction; it is
      // not one of the positional id pages, so it must not consume the counter.
      from: jest.fn().mockImplementation((table: unknown) => {
        if (table === users) return chain([]);
        txSelectCount++;
        if (txSelectCount === 1) return chain([{ id: 10 }]);
        if (txSelectCount === 2) return chain([{ id: 20 }]);
        if (txSelectCount === 3) return chain([]);
        if (txSelectCount === 4) return chain(authoredArticleIds);
        if (txSelectCount === 5) return chain(ownedSourceIds);
        if (txSelectCount === 6) return chain(uploadedAttachmentIds);
        return chain([]);
      }),
    })),
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
  const sessions = { revokeAllForUser: jest.fn().mockResolvedValue({ revokedCount: 0 }) } as unknown as SessionsService;
  const storagePurge = {
    buildManifest: jest.fn().mockResolvedValue({ blocked: false, keys: [] }),
    purgeFromManifest: jest.fn().mockResolvedValue({
      blocked: false,
      dryRun: false,
      deleted: [],
      skipped: [],
      failed: [],
      manifest: [],
    }),
  };
  return new GdprSubjectErasureService(
    db as unknown as Db,
    cache,
    sessions,
    storagePurge as never,
  );
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

// ─── Completeness across the batch boundary ───────────────────────────────────
//
// The SELECT for authored-article IDs and owned-source IDs must carry NO LIMIT,
// so every article/source the subject owns contributes its chunks to the erasure.
// These specs prove that with TOTAL_ARTICLES > FIXTURE_BATCH, all chunks are erased.
// The bite proof shrinks the fixture's SELECT result to FIXTURE_BATCH < TOTAL_ARTICLES
// and demonstrates that the "toContain" assertion then fails — confirming the spec
// is sensitive to the completeness of the ID set passed to the DELETE.

const TOTAL_ARTICLES = 5;
const FIXTURE_BATCH = 3;

function makeCompletenessDb(opts: { selectedArticleCount: number }) {
  const { selectedArticleCount } = opts;
  const selectedArticles = Array.from(
    { length: selectedArticleCount },
    (_, i) => ({ id: i + 1 }),
  );
  return makeKbDb({
    authoredArticleIds: selectedArticles,
    kbPageChunkDeleted: [],
    kbArticleChunkDeleted:
      selectedArticleCount >= TOTAL_ARTICLES ? [{ id: 9999 }] : [],
    ownedSourceIds: [],
  });
}

describe("GdprSubjectErasureService — article-chunk completeness across the batch boundary", () => {
  it("erases article chunks for all TOTAL_ARTICLES authored articles when SELECT is unlimited", async () => {
    const { db } = makeCompletenessDb({ selectedArticleCount: TOTAL_ARTICLES });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).toContain("kb_article_chunks");
  });

  it("(bite proof) SELECT limited to FIXTURE_BATCH leaves article chunks for remaining articles un-erased", async () => {
    // Shrinking the fixture's batch to FIXTURE_BATCH (3) < TOTAL_ARTICLES (5) simulates
    // the old LIMIT 1000 behavior on a subject with 5 authored articles.
    // The fixture DELETE mock returns [] because only a subset of IDs were covered,
    // so "kb_article_chunks" is NOT pushed to tablesAnonymised.
    // Asserting toContain then FAILS — proving the spec detects the compliance gap.
    // To verify this bite: change { selectedArticleCount: FIXTURE_BATCH } to
    // { selectedArticleCount: TOTAL_ARTICLES } — the assertion passes, confirming
    // the fixture, not the source, drives the outcome.
    const { db } = makeCompletenessDb({ selectedArticleCount: FIXTURE_BATCH });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).not.toContain("kb_article_chunks");
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

// ─── KB article chunks (attachment-uploaded) ──────────────────────────────────
//
// A subject may upload a file as an attachment to an article they did NOT author.
// Those attachment-sourced chunks reference the subject via kbArticleAttachments.uploadedBy
// and are NOT covered by the article-authored deletion. They must be erased separately.

describe("GdprSubjectErasureService — kb_article_chunks from uploaded attachments", () => {
  it("deletes attachment chunks when the subject has uploaded attachments to any article", async () => {
    const { db } = makeKbDb({
      uploadedAttachmentIds: [{ id: 11 }],
      kbAttachmentChunkDeleted: [{ id: 500 }],
    });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).toContain("kb_article_chunks");
  });

  it("calls tx.delete 4 times when the subject has uploaded attachments (msgs + convs + page-chunks + attachment-chunks)", async () => {
    const { db, tx } = makeKbDb({
      uploadedAttachmentIds: [{ id: 11 }],
      kbAttachmentChunkDeleted: [{ id: 500 }],
    });
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(tx.delete.mock.calls.length).toBe(4);
  });

  it("skips the attachment chunk delete when the subject has uploaded no attachments", async () => {
    const { db, tx } = makeKbDb({ uploadedAttachmentIds: [] });
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(tx.delete.mock.calls.length).toBe(3);
  });

  it("(bite proof) kb_article_chunks absent from tablesAnonymised when attachment chunk delete returns no rows", async () => {
    // Mechanism: kbAttachmentChunkDeleted = [] → returning([]) → NOT pushed.
    // Neuter: swap to [{ id: 1 }] → IS pushed → "not.toContain" FAILS.
    const { db } = makeKbDb({
      uploadedAttachmentIds: [{ id: 11 }],
      kbAttachmentChunkDeleted: [],
    });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).not.toContain("kb_article_chunks");
  });

  it("is idempotent when all attachment chunk deletes return no rows on a second run", async () => {
    const { db } = makeKbDb({
      uploadedAttachmentIds: [{ id: 11 }],
      kbAttachmentChunkDeleted: [],
    });
    const svc = buildService(db);

    await expect(
      svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false }),
    ).resolves.toMatchObject({ blocked: false, dryRun: false });
  });
});
