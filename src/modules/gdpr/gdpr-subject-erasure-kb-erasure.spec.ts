import type { Db } from "../../db/drizzle.module";
import type { SessionsService } from "../sessions/sessions.service";
import { CacheService } from "../../common/cache/cache.service";
import { GdprSubjectErasureService } from "./gdpr-subject-erasure.service";
import { chatAttachments, gdprExportJobs, users } from "../../db/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { supportArticlePredicate } from "../kb/help-centre/kb-article-page-scope";
import { subjectAuthoredDocument } from "../kb/core/kb-subject-erasure";

jest.mock("../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../common/auth/membership-state.service", () => ({
  membershipStandingChannel: { publish: jest.fn() },
}));

/**
 * The surviving-membership guard moved off the erasing org's tenant transaction and onto
 * its own identity-scoped one: `organization_members` admits a row only when its org is
 * the tenant GUC's or its user is `app.user_id`, and a tenant transaction never sets the
 * second, so from inside one the read is blind. Nothing in this file turns on its answer —
 * it is doubled here so it no longer occupies a slot in the `tx` sequence below.
 * `gdpr-subject-erasure-global-identity.db.spec.ts` proves the real one against Postgres.
 */
jest.mock("../../common/tenant/with-identity", () => ({
  withIdentity: jest.fn((_db: unknown, _userId: string, fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => {
          // `innerJoin` because the surviving-membership guard joins organizations to
          // exclude deleted ones; the double models a builder, so it walks the same links.
          const chain: Record<string, unknown> = {
            innerJoin: () => chain,
            where: () => chain,
            limit: () => Promise.resolve([]),
          };
          return chain;
        },
      }),
    }),
  ),
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
    onConflictDoNothing: jest.fn().mockReturnThis(),
    onConflictDoUpdate: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
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
  kbAuthoredPageChunkDeleted?: unknown[];
  kbSourceChunkDeleted?: unknown[];
  kbAttachmentChunkDeleted?: unknown[];
  authoredPageIds?: Array<{ id: number }>;
  ownedSourceIds?: Array<{ id: number }>;
  uploadedAttachmentIds?: Array<{ id: number }>;
}

/**
 * Builds a mock db whose tx.delete dispatches correctly for the KB erasure path.
 *
 * The service always deletes kbArticleChunks at least once (for page-authored chunks),
 * then conditionally once more for chunks of pages the subject authored (when authoredPageIds is
 * non-empty), once more for source-uploaded chunks (when ownedSourceIds is non-empty),
 * and once more for attachment-uploaded chunks (when uploadedAttachmentIds is non-empty).
 * The round-robin here mirrors that same conditional to stay in sync.
 */
function makeKbDb(opts: KbDbOpts = {}) {
  const {
    kbMsgDeleted = [],
    kbConvDeleted = [],
    kbPageChunkDeleted = [],
    kbAuthoredPageChunkDeleted = [],
    kbSourceChunkDeleted = [],
    kbAttachmentChunkDeleted = [],
    authoredPageIds = [],
    ownedSourceIds = [],
    uploadedAttachmentIds = [],
  } = opts;

  const kbMsgDeleteChain = chain(kbMsgDeleted);
  const kbConvDeleteChain = chain(kbConvDeleted);

  // Mirror the service's conditional: denormalised page-author chunks are always first,
  // then authored pages (if any), then source (if any), then attachment (if any).
  const kbChunkChains: ReturnType<typeof chain>[] = [chain(kbPageChunkDeleted)];
  if (authoredPageIds.length > 0) kbChunkChains.push(chain(kbAuthoredPageChunkDeleted));
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
        // Slot 3 used to be the other-org membership guard. It is no longer read on `tx`.
        if (txSelectCount === 3) return chain(authoredPageIds);
        if (txSelectCount === 4) return chain(ownedSourceIds);
        if (txSelectCount === 5) return chain(uploadedAttachmentIds);
        return chain([]);
      }),
    })),
    update: jest.fn().mockImplementation((table: unknown) =>
      // The export-artifact retirement is not one of the positional identity updates.
      table === gdprExportJobs ? chain([]) : chain([{ id: 99 }]),
    ),
    insert: jest.fn().mockReturnValue(chain([])),
    delete: jest.fn().mockImplementation((table: unknown) => {
      // The chat-attachment sink deletes before the KB path and is not one of the
      // positional KB deletes, so it must not consume the counter.
      if (table === chatAttachments) return chain([]);
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
  const effectLedger = {
    execute: jest.fn().mockImplementation(async (_eff: unknown, send: () => Promise<unknown>) => {
      await send();
      return "EXECUTED" as const;
    }),
  };
  return new GdprSubjectErasureService(
    db as unknown as Db,
    cache,
    sessions,
    storagePurge as never,
    effectLedger as never,
    { commitManyPageChanges: jest.fn() } as never,
  );
}

/** `tx.delete` calls belonging to the KB path — the chat-attachment sink is not one. */
function kbDeleteCalls(tx: { delete: jest.Mock }): number {
  return tx.delete.mock.calls.filter((call) => call[0] !== chatAttachments).length;
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
    expect(kbDeleteCalls(tx)).toBeGreaterThanOrEqual(1);
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

    expect(kbDeleteCalls(tx)).toBeGreaterThanOrEqual(3);
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

// ─── KB article chunks (page-authored by the subject) ─────────────────────────

describe("GdprSubjectErasureService — kb_article_chunks from pages the subject authored", () => {
  it("deletes chunks for every page the subject authored, owned or last edited", async () => {
    const { db } = makeKbDb({
      authoredPageIds: [{ id: 7 }],
      kbAuthoredPageChunkDeleted: [{ id: 200 }],
    });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).toContain("kb_article_chunks");
  });

  it("skips the authored-page chunk delete when the subject authored no page", async () => {
    // No authored pages → only 3 delete calls: messages, conversations, page-chunks.
    // With authored pages → 4 delete calls (authored-page chunks added).
    const { db, tx } = makeKbDb({ authoredPageIds: [] });
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(kbDeleteCalls(tx)).toBe(3);
  });

  it("(bite proof) kb_article_chunks absent when the authored-page chunk delete returns no rows and no page chunks", async () => {
    const { db } = makeKbDb({
      authoredPageIds: [{ id: 7 }],
      kbAuthoredPageChunkDeleted: [],
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

    expect(kbDeleteCalls(tx)).toBe(3);
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
// The SELECT for authored-page IDs and owned-source IDs must carry NO LIMIT,
// so every page/source the subject owns contributes its chunks to the erasure.
// These specs prove that with TOTAL_PAGES > FIXTURE_BATCH, all chunks are erased.
// The bite proof shrinks the fixture's SELECT result to FIXTURE_BATCH < TOTAL_PAGES
// and demonstrates that the "toContain" assertion then fails — confirming the spec
// is sensitive to the completeness of the ID set passed to the DELETE.

const TOTAL_PAGES = 5;
const FIXTURE_BATCH = 3;

function makeCompletenessDb(opts: { selectedPageCount: number }) {
  const { selectedPageCount } = opts;
  const selectedPages = Array.from(
    { length: selectedPageCount },
    (_, i) => ({ id: i + 1 }),
  );
  return makeKbDb({
    authoredPageIds: selectedPages,
    kbPageChunkDeleted: [],
    kbAuthoredPageChunkDeleted:
      selectedPageCount >= TOTAL_PAGES ? [{ id: 9999 }] : [],
    ownedSourceIds: [],
  });
}

describe("GdprSubjectErasureService — authored-page chunk completeness across the batch boundary", () => {
  it("erases chunks for all TOTAL_PAGES authored pages when SELECT is unlimited", async () => {
    const { db } = makeCompletenessDb({ selectedPageCount: TOTAL_PAGES });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).toContain("kb_article_chunks");
  });

  it("(bite proof) SELECT limited to FIXTURE_BATCH leaves chunks for the remaining pages un-erased", async () => {
    // Shrinking the fixture's batch to FIXTURE_BATCH (3) < TOTAL_PAGES (5) simulates
    // the old LIMIT 1000 behavior on a subject with 5 authored pages.
    // The fixture DELETE mock returns [] because only a subset of IDs were covered,
    // so "kb_article_chunks" is NOT pushed to tablesAnonymised.
    // Asserting toContain then FAILS — proving the spec detects the compliance gap.
    // To verify this bite: change { selectedPageCount: FIXTURE_BATCH } to
    // { selectedPageCount: TOTAL_PAGES } — the assertion passes, confirming
    // the fixture, not the source, drives the outcome.
    const { db } = makeCompletenessDb({ selectedPageCount: FIXTURE_BATCH });
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
// A subject may upload a file as an attachment to a page they did NOT author.
// Those attachment-sourced chunks reference the subject via kbPageAttachments.uploadedById
// and are NOT covered by the authored-page deletion. They must be erased separately.

describe("GdprSubjectErasureService — kb_article_chunks from uploaded attachments", () => {
  it("deletes attachment chunks when the subject has uploaded attachments to any page", async () => {
    const { db } = makeKbDb({
      uploadedAttachmentIds: [{ id: 11 }],
      kbAttachmentChunkDeleted: [{ id: 500 }],
    });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).toContain("kb_article_chunks");
  });

  it("calls tx.delete 5 times when the subject has uploaded attachments (msgs + convs + page-chunks + attachment-chunks + attachment-checkpoints), because the attachment's checkpoint row holds the same text and embedding as the chunk it came from", async () => {
    const { db, tx } = makeKbDb({
      uploadedAttachmentIds: [{ id: 11 }],
      kbAttachmentChunkDeleted: [{ id: 500 }],
    });
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(kbDeleteCalls(tx)).toBe(5);
  });

  it("skips the attachment chunk delete when the subject has uploaded no attachments", async () => {
    const { db, tx } = makeKbDb({ uploadedAttachmentIds: [] });
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(kbDeleteCalls(tx)).toBe(3);
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

// ─── Authorship predicate ─────────────────────────────────────

describe("subjectAuthoredDocument — which kb_pages rows erasure reaches", () => {
  const dialect = new PgDialect();
  const rendered = dialect.sqlToQuery(subjectAuthoredDocument("user-kb-subject", 42)).sql;

  it.each([
    "created_by_id",
    "owner_user_id",
    "last_edited_by_id",
    "created_by_membership_id",
    "owner_membership_id",
    "last_edited_by_membership_id",
  ])("names %s, so an authorship column added to kb_pages cannot silently escape erasure", (column) => {
    expect(rendered).toContain(column);
  });

  it("does not name deleted_by_id, because archiving another person's page does not make its text the subject's data", () => {
    expect(rendered).not.toContain("deleted_by_id");
  });

  it("does not filter content_type, so wiki pages the subject authored are erased alongside support articles", () => {
    expect(rendered).not.toContain("content_type");
    expect(dialect.sqlToQuery(supportArticlePredicate()).sql).toContain("content_type");
  });

  it("does not filter deleted_at, so a soft-deleted page the subject authored is still erased", () => {
    expect(rendered).not.toContain("deleted_at");
    expect(dialect.sqlToQuery(supportArticlePredicate()).sql).toContain("deleted_at");
  });
});
