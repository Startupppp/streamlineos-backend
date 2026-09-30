import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { CacheService } from "../../common/cache/cache.service";
import {
  chatAttachments,
  chatMessages,
  hrLegalHolds,
  organizationMembers,
} from "../../db/schema";
import { ERASURE_ID_PAGE } from "./gdpr-subject-erasure-paging";
import { GdprSubjectErasureService } from "./gdpr-subject-erasure.service";

jest.mock("../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../common/auth/membership-state.service", () => ({
  bustMembershipStatusCache: jest.fn().mockResolvedValue(undefined),
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
          // The surviving-membership guard joins organizations to exclude deleted ones;
          // this double models a builder, so it walks the same links the query does.
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

jest.mock("../support/core/support-ticket-erasure", () => ({
  anonymiseSubjectSupportTickets: jest
    .fn()
    .mockResolvedValue({ ticketsAnonymised: 0, embeddingsDeleted: 0 }),
}));

// ─── The subject's uploaded chat files outlived their erasure ────────────────
//
// MECHANISM: `collectSubjectFileKeysWithLegalHold` attributes an object to a subject only
// through a real foreign key to `public.users`. `chat_attachments` has none — it reaches
// the person only through `chat_messages.sender_membership_id` — so the table was
// classified `org-id`, and `purgeFromManifest` skips `org-id` keys deliberately. Erasure
// redacted `chat_messages.content` to `[ERASED]` and left `file_name`, the public
// `file_url` and the object in the bucket.
//
// The fixture is LARGER than ERASURE_ID_PAGE. A fixture that fits in one page cannot tell
// a drain from a single capped statement, which is the defect this ticket shipped twice.

const ORG = "org-chat-attach";
const SUBJECT = "user-chat-subject";
const ACTOR = "user-chat-actor";
const MESSAGE_COUNT = ERASURE_ID_PAGE * 2 + 13;

interface Attachment {
  messageId: number;
  fileKey: string;
}

interface Store {
  messageIds: number[];
  attachments: Attachment[];
  legalHolds: Array<{ id: number; reason: string }>;
  attachmentDeleteCalls: number;
  deletePredicates: string[];
  deletedIdParams: number[][];
  callOrder: string[];
}

function attachmentKeyFor(messageId: number): string {
  return `chat/${ORG}/attachment-${String(messageId).padStart(6, "0")}.bin`;
}

function makeStore(messages: number, withAttachments = true): Store {
  const messageIds = Array.from({ length: messages }, (_, i) => i + 1);
  return {
    messageIds,
    attachments: withAttachments
      ? messageIds.map((id) => ({ messageId: id, fileKey: attachmentKeyFor(id) }))
      : [],
    legalHolds: [],
    attachmentDeleteCalls: 0,
    deletePredicates: [],
    deletedIdParams: [],
    callOrder: [],
  };
}

/**
 * Reads the message-id page out of the real `and(eq(org_id), inArray(message_id, page))`
 * the service built, so the double answers the predicate it was actually given rather
 * than mirroring an assumed chunk size.
 */
function pageFromPredicate(condition: unknown): { sql: string; ids: number[] } {
  const query = new PgDialect().sqlToQuery(condition as SQL);
  return { sql: query.sql, ids: query.params.slice(1).map(Number) };
}

function makeDb(store: Store) {
  const dbSelectChain = () => {
    let table: unknown = null;
    const resolve = (): unknown[] => {
      if (table === organizationMembers) return [{ id: 77 }];
      if (table === hrLegalHolds) return store.legalHolds;
      return [];
    };
    const chain = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      // The surviving-membership guard joins organizations to exclude deleted orgs;
      // the double models a builder, so it needs the link the query now walks.
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(resolve()),
      then: (onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onOk, onErr),
    };
    return chain;
  };

  const emptySelectChain = () => {
    const chain = {
      from: () => chain,
      // The surviving-membership guard joins organizations to exclude deleted orgs;
      // the double models a builder, so it needs the link the query now walks.
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve([]),
      then: (onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(onOk, onErr),
    };
    return chain;
  };

  const updateChain = (table: unknown) => {
    const apply = (): unknown[] => {
      if (table === chatMessages) {
        store.callOrder.push("tx.chat_messages.update");
        return store.messageIds.map((id) => ({ id }));
      }
      return [];
    };
    const chain = {
      set: () => chain,
      // The surviving-membership guard joins organizations to exclude deleted orgs;
      // the double models a builder, so it needs the link the query now walks.
      innerJoin: () => chain,
      where: () => chain,
      returning: () => Promise.resolve(apply()),
      then: (onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) =>
        Promise.resolve(apply()).then(onOk, onErr),
    };
    return chain;
  };

  const deleteChain = (table: unknown) => {
    let removed: unknown[] = [];
    const chain = {
      where: (condition: unknown) => {
        if (table === chatAttachments) {
          const { sql, ids } = pageFromPredicate(condition);
          store.callOrder.push("tx.chat_attachments.delete");
          store.attachmentDeleteCalls += 1;
          store.deletePredicates.push(sql);
          store.deletedIdParams.push(ids);
          const wanted = new Set(ids);
          removed = store.attachments
            .filter((a) => wanted.has(a.messageId))
            .map((a) => ({ fileKey: a.fileKey }));
        }
        return chain;
      },
      returning: () => Promise.resolve(removed),
      then: (onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) =>
        Promise.resolve(removed).then(onOk, onErr),
    };
    return chain;
  };

  const tx = {
    select: jest.fn(() => emptySelectChain()),
    update: jest.fn((t: unknown) => updateChain(t)),
    delete: jest.fn((t: unknown) => deleteChain(t)),
    insert: jest.fn(() => {
      const insertChain: Record<string, unknown> = {
        values: () => insertChain,
        onConflictDoNothing: () => insertChain,
        onConflictDoUpdate: () => insertChain,
        returning: () => Promise.resolve([{ id: 1 }]),
        then: (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
          Promise.resolve([{ id: 1 }]).then(resolve, reject),
      };
      return insertChain;
    }),
  };

  const db = {
    select: jest.fn(() => dbSelectChain()),
    update: jest.fn((t: unknown) => updateChain(t)),
    insert: jest.fn(() => {
      const postChain: Record<string, unknown> = {
        values: () => postChain,
        onConflictDoNothing: () => postChain,
        onConflictDoUpdate: () => postChain,
        returning: () => Promise.resolve([{ id: 1 }]),
        then: (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
          Promise.resolve([{ id: 1 }]).then(resolve, reject),
      };
      return postChain;
    }),
    transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      store.callOrder.push("db.transaction");
      return fn(tx);
    }),
  };
  return { db, tx };
}

interface ManifestKey {
  key: string;
  table: string;
  column: string;
  source: string;
  orgId: string | null;
}

interface ManifestDouble {
  blocked: boolean;
  blockReason?: string;
  keys: ManifestKey[];
}

function makePurgeDouble(store?: Store) {
  return {
    buildManifest: jest.fn(
      async (): Promise<ManifestDouble> => ({ blocked: false, keys: [] }),
    ),
    purgeFromManifest: jest.fn(async (manifest: ManifestDouble) => {
      store?.callOrder.push("purge.purgeFromManifest");
      return {
        blocked: false,
        dryRun: false,
        deleted: [],
        skipped: [],
        failed: [],
        manifest: manifest.keys,
      };
    }),
  };
}

function buildService(db: unknown, purge: unknown) {
  const cache = {} as CacheService;
  const effectLedger = {
    execute: jest.fn().mockImplementation(async (_eff: unknown, send: () => Promise<unknown>) => {
      await send();
      return "EXECUTED" as const;
    }),
  };
  const sessions = { revokeAllForUser: jest.fn().mockResolvedValue({ revokedCount: 0 }) };
  return new GdprSubjectErasureService(db as never, cache, sessions as never, purge as never, effectLedger as never, { commitManyPageChanges: jest.fn() } as never);
}

function manifestKeys(purge: ReturnType<typeof makePurgeDouble>): ManifestKey[] {
  const manifest = purge.purgeFromManifest.mock.calls[0]?.[0];
  return (manifest?.keys ?? []).filter((k) => k.table === "public.chat_attachments");
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GdprSubjectErasureService — the subject's chat attachments are purged", () => {
  it("spends every page of the subject's message ids and hands each key to the purge", async () => {
    const store = makeStore(MESSAGE_COUNT);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    const result = await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: false,
    });

    expect(store.attachmentDeleteCalls).toBe(3);
    expect(manifestKeys(purge)).toHaveLength(MESSAGE_COUNT);
    expect(manifestKeys(purge).map((k) => k.key)).toContain(
      attachmentKeyFor(MESSAGE_COUNT),
    );
    expect(result.tablesAnonymised).toContain("chat_attachments");
  });

  it("(bite proof) a subject inside one page yields one delete — the multi-page count is not an artefact", async () => {
    const store = makeStore(7);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(store.attachmentDeleteCalls).toBe(1);
    expect(manifestKeys(purge)).toHaveLength(7);
  });

  it("never asks for more than one page of ids in a single statement", async () => {
    const store = makeStore(MESSAGE_COUNT);
    const { db } = makeDb(store);

    await buildService(db, makePurgeDouble()).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: false,
    });

    for (const ids of store.deletedIdParams)
      expect(ids.length).toBeLessThanOrEqual(ERASURE_ID_PAGE);
    expect(store.deletedIdParams.flat()).toHaveLength(MESSAGE_COUNT);
  });

  it("binds the erasing organisation into the delete itself, not only into the id list", async () => {
    const store = makeStore(5);
    const { db } = makeDb(store);

    await buildService(db, makePurgeDouble()).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: false,
    });

    expect(store.deletePredicates).toHaveLength(1);
    const predicate = store.deletePredicates[0] ?? "";
    expect(predicate).toContain('"chat_attachments"."org_id"');
    expect(predicate).toContain('"chat_attachments"."message_id" in');
  });

  it("marks them user-fk, not org-id — purgeFromManifest SKIPS org-id keys by design", async () => {
    const store = makeStore(3);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    for (const key of manifestKeys(purge)) {
      expect(key.source).toBe("user-fk");
      expect(key.table).toBe("public.chat_attachments");
      expect(key.column).toBe("file_key");
      expect(key.orgId).toBe(ORG);
    }
  });

  it("removes the row and captures its key in one statement, and purges only after the commit", async () => {
    const store = makeStore(2);
    const { db } = makeDb(store);
    const purge = makePurgeDouble(store);

    await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    const opened = store.callOrder.indexOf("db.transaction");
    const deleted = store.callOrder.indexOf("tx.chat_attachments.delete");
    const purged = store.callOrder.indexOf("purge.purgeFromManifest");
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeGreaterThan(opened);
    expect(purged).toBeGreaterThan(deleted);
    expect(purge.purgeFromManifest).toHaveBeenCalledTimes(1);
  });
});

describe("GdprSubjectErasureService — the chat-attachment sink is driven by the redaction", () => {
  it("(bite proof) a subject who sent no message deletes nothing and claims no table", async () => {
    const store = makeStore(0);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    const result = await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: false,
    });

    expect(store.attachmentDeleteCalls).toBe(0);
    expect(manifestKeys(purge)).toHaveLength(0);
    expect(result.tablesAnonymised).not.toContain("chat_attachments");
  });

  it("(bite proof) messages with no attachment still claim no table and add no key", async () => {
    const store = makeStore(12, false);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    const result = await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: false,
    });

    expect(store.attachmentDeleteCalls).toBe(1);
    expect(manifestKeys(purge)).toHaveLength(0);
    expect(result.tablesAnonymised).not.toContain("chat_attachments");
    expect(result.tablesAnonymised).toContain("chat_messages");
  });

  it("a second run over an already-purged subject claims no table and adds no key", async () => {
    const first = makeStore(3);
    const firstResult = await buildService(makeDb(first).db, makePurgeDouble()).eraseSubject(
      SUBJECT,
      ORG,
      ACTOR,
      { dryRun: false },
    );

    // The redaction is unconditional, so it returns the same message ids on a second run;
    // the attachment rows are gone, so the same drain removes nothing.
    const second = makeStore(3, false);
    const purge = makePurgeDouble();
    const result = await buildService(makeDb(second).db, purge).eraseSubject(
      SUBJECT,
      ORG,
      ACTOR,
      { dryRun: false },
    );

    expect(firstResult.tablesAnonymised).toContain("chat_attachments");
    expect(result.tablesAnonymised).not.toContain("chat_attachments");
    expect(manifestKeys(purge)).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });
});

describe("GdprSubjectErasureService — legal hold blocks the chat-attachment sink", () => {
  it("deletes no attachment and purges nothing when an active hold exists", async () => {
    const store = makeStore(5);
    store.legalHolds = [{ id: 9, reason: "litigation-hold" }];
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    const result = await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: false,
    });

    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe("litigation-hold");
    expect(store.attachmentDeleteCalls).toBe(0);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(purge.purgeFromManifest).not.toHaveBeenCalled();
  });

  it("(bite proof) with the hold released the same fixture DOES delete and purge", async () => {
    const store = makeStore(5);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    const result = await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: false,
    });

    expect(result.blocked).toBe(false);
    expect(store.attachmentDeleteCalls).toBe(1);
    expect(manifestKeys(purge)).toHaveLength(5);
  });

  it("a storage manifest blocked downstream leaves the attachment rows in place", async () => {
    const store = makeStore(5);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();
    purge.buildManifest.mockResolvedValue({
      blocked: true,
      blockReason: "active-legal-hold",
      keys: [],
    });

    const result = await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: false,
    });

    expect(store.attachmentDeleteCalls).toBe(0);
    expect(result.tablesAnonymised).not.toContain("chat_attachments");
  });
});

describe("GdprSubjectErasureService — dry run declares the chat-attachment sink", () => {
  it("names chat_attachments and writes nothing", async () => {
    const store = makeStore(4);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    const result = await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.tablesAnonymised).toContain("chat_attachments");
    expect(store.attachmentDeleteCalls).toBe(0);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(purge.purgeFromManifest).not.toHaveBeenCalled();
  });
});
