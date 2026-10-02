import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { GdprSubjectErasureService } from "./gdpr-subject-erasure.service";
import { GdprStoragePurgeService } from "./gdpr-storage-purge.service";
import { StorageService } from "../storage/storage.service";
import type { SubjectFileKey } from "../storage/storage-key-catalog";
import {
  kbArticleChunks,
  kbIngestionCheckpoints,
  users,
} from "../../db/schema";

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

const ORG = "org-sink";
const SUBJECT = "user-sink-subject";
const ACTOR = "user-sink-actor";
const ERASURE_ID_PAGE = 200;

function chain(result: unknown[] = []) {
  return {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(result),
    returning: jest.fn().mockResolvedValue(result),
    onConflictDoNothing: jest.fn().mockReturnThis(),
    onConflictDoUpdate: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    then: (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
}

interface HarnessOptions {
  selectPages?: unknown[][];
  membershipRows?: unknown[];
  legalHoldRows?: unknown[];
}

function makeHarness(options: HarnessOptions = {}) {
  const selectPages = options.selectPages ?? [];
  const chunkDeleteChains: ReturnType<typeof chain>[] = [];
  const checkpointDeleteChains: ReturnType<typeof chain>[] = [];

  let txSelectCount = 0;
  const tx = {
    select: jest.fn().mockImplementation(() => ({
      // The support-ticket erasure probes `users.email` inside the transaction; it is
      // not one of the positional id pages, so it must not consume the counter.
      from: jest.fn().mockImplementation((table: unknown) => {
        if (table === users) return chain([]);
        const page = selectPages[txSelectCount] ?? [];
        txSelectCount++;
        return chain(page);
      }),
    })),
    update: jest.fn().mockImplementation(() => chain([])),
    insert: jest.fn().mockImplementation(() => chain([{ id: 1 }])),
    delete: jest.fn().mockImplementation((table: unknown) => {
      if (table === kbArticleChunks) {
        const c = chain([{ id: 1 }]);
        chunkDeleteChains.push(c);
        return c;
      }
      if (table === kbIngestionCheckpoints) {
        const c = chain([{ id: 1 }]);
        checkpointDeleteChains.push(c);
        return c;
      }
      return chain([]);
    }),
  };

  let dbSelectCount = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      dbSelectCount++;
      if (dbSelectCount === 1) return chain(options.membershipRows ?? [{ id: 1 }]);
      return chain(options.legalHoldRows ?? []);
    }),
    insert: jest.fn().mockImplementation(() => chain([{ id: 1 }])),
    update: jest.fn().mockImplementation(() => chain([])),
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { db, tx, chunkDeleteChains, checkpointDeleteChains };
}

function makePurgeDouble(deleted: string[] = [], keys: SubjectFileKey[] = []) {
  return {
    buildManifest: jest.fn().mockResolvedValue({ blocked: false, keys }),
    purgeFromManifest: jest.fn().mockResolvedValue({
      blocked: false,
      dryRun: false,
      deleted,
      skipped: [],
      failed: [],
      manifest: keys,
    }),
  };
}

function buildService(
  db: ReturnType<typeof makeHarness>["db"],
  purge: ReturnType<typeof makePurgeDouble>,
) {
  const cache = {} as CacheService;
  const effectLedger = {
    execute: jest.fn().mockImplementation(async (_eff: unknown, send: () => Promise<unknown>) => {
      await send();
      return "EXECUTED" as const;
    }),
  };
  const sessions = { revokeAllForUser: jest.fn().mockResolvedValue({ revokedCount: 0 }) };
  return new GdprSubjectErasureService(
    db as unknown as Db,
    cache,
    sessions as never,
    purge as never,
    effectLedger as never,
    { commitManyPageChanges: jest.fn() } as never,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Object storage is a sink of erasure, not only a database column ─────────
//
// MECHANISM: the erasure endpoint used to call the database anonymisation alone.
// GdprStoragePurgeService existed, was provided by GdprModule, and had zero callers,
// so every avatar, payslip and uploaded document survived the record that named it.

describe("GdprSubjectErasureService — object storage purge", () => {
  const KEY: SubjectFileKey = {
    key: "documents/payslip.pdf",
    table: "public.hr_documents",
    column: "file_key",
    source: "user-fk",
    orgId: ORG,
  };

  it("deletes the storage objects, not only the rows that point at them", async () => {
    const { db } = makeHarness();
    const purge = makePurgeDouble([KEY.key], [KEY]);
    const service = buildService(db, purge);

    const result = await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(purge.purgeFromManifest).toHaveBeenCalledTimes(1);
    expect(result.storage).toEqual({
      manifestSize: 1,
      deleted: 1,
      skipped: 0,
      failed: 0,
    });
    expect(result.tablesAnonymised).toContain("object_storage");
  });

  it("builds the manifest BEFORE the transaction — a key column nulled first would orphan its object", async () => {
    const { db } = makeHarness();
    const purge = makePurgeDouble([KEY.key], [KEY]);
    const service = buildService(db, purge);

    await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    const manifestOrder = purge.buildManifest.mock.invocationCallOrder[0];
    const txOrder = db.transaction.mock.invocationCallOrder[0];
    const purgeOrder = purge.purgeFromManifest.mock.invocationCallOrder[0];
    expect(manifestOrder).toBeLessThan(txOrder);
    expect(purgeOrder).toBeGreaterThan(txOrder);
  });

  it("(bite proof) a dry run reports the manifest size and deletes nothing", async () => {
    const { db } = makeHarness();
    const purge = makePurgeDouble([KEY.key], [KEY]);
    const service = buildService(db, purge);

    const result = await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: true });

    expect(result.storage.manifestSize).toBe(1);
    expect(result.storage.deleted).toBe(0);
    expect(purge.purgeFromManifest).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("(bite proof) an active legal hold blocks the purge — no manifest is even built", async () => {
    const { db } = makeHarness({ legalHoldRows: [{ id: 7, reason: "litigation" }] });
    const purge = makePurgeDouble();
    const service = buildService(db, purge);

    const result = await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.blocked).toBe(true);
    expect(purge.buildManifest).not.toHaveBeenCalled();
    expect(purge.purgeFromManifest).not.toHaveBeenCalled();
  });
});

// ─── Keyset drains, proven with more rows than one page ──────────────────────
//
// A fixture smaller than the page size cannot catch a bare `.limit(n)`: a single
// call returns everything and the assertion passes either way.

describe("GdprSubjectErasureService — KB drains page past the page size", () => {
  const FULL_PAGE = Array.from({ length: ERASURE_ID_PAGE }, (_, i) => ({ id: i + 1 }));
  const TAIL_PAGE = [{ id: ERASURE_ID_PAGE + 1 }];

  it("drains authored articles across every page, so a prolific author's chunks are all removed", async () => {
    const { db, chunkDeleteChains } = makeHarness({
      selectPages: [
        [], // hr_people — empty, so no employment page follows
        FULL_PAGE, // authored articles, page 1
        TAIL_PAGE, // authored articles, page 2
        [], // owned sources
        [], // uploaded attachments
        [], // authored pages
      ],
    });
    const service = buildService(db, makePurgeDouble());

    const result = await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    // page-authored chunks (1) + article chunks for page 1 and page 2 (2) = 3
    expect(chunkDeleteChains).toHaveLength(3);
    expect(result.tablesAnonymised).toContain("kb_article_chunks");
  });

  it("drains uploaded attachments across every page", async () => {
    const { db, chunkDeleteChains } = makeHarness({
      selectPages: [
        [], // hr_people
        [], // authored articles
        [], // owned sources
        FULL_PAGE, // uploaded attachments, page 1
        TAIL_PAGE, // uploaded attachments, page 2
        [], // authored pages
      ],
    });
    const service = buildService(db, makePurgeDouble());

    await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(chunkDeleteChains).toHaveLength(3);
  });

  it("(bite proof) a single short page stops after one delete — the multi-page count is not an artefact", async () => {
    const { db, chunkDeleteChains } = makeHarness({
      selectPages: [[], [{ id: 1 }], [], [], []],
    });
    const service = buildService(db, makePurgeDouble());

    await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(chunkDeleteChains).toHaveLength(2);
  });
});

// ─── The embedding checkpoint is a sink too ──────────────────────────────────
//
// kb_ingestion_checkpoints stores the chunk text AND its embedding, keyed by
// (content_type, content_id). No foreign key ties it to kb_article_chunks, so
// deleting the chunks leaves the subject's text and vector behind.

describe("GdprSubjectErasureService — kb_ingestion_checkpoints", () => {
  it("clears the checkpoints for the subject's authored pages and for the attachments they uploaded, because indexing writes a checkpoint row under page, article and attachment content types and an unerased row keeps the subject's text and embedding", async () => {
    const { db, checkpointDeleteChains } = makeHarness({
      selectPages: [
        [], // hr_people
        [{ id: 5 }], // authored pages, covering the article content type too
        [], // owned sources
        [{ id: 9 }], // uploaded attachments
      ],
    });
    const service = buildService(db, makePurgeDouble());

    const result = await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(checkpointDeleteChains).toHaveLength(2);
    expect(result.tablesAnonymised).toContain("kb_ingestion_checkpoints");
  });

  it("(bite proof) no authored content means no checkpoint delete and no table claim", async () => {
    const { db, checkpointDeleteChains } = makeHarness({
      selectPages: [[], [], [], [], []],
    });
    const service = buildService(db, makePurgeDouble());

    const result = await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(checkpointDeleteChains).toHaveLength(0);
    expect(result.tablesAnonymised).not.toContain("kb_ingestion_checkpoints");
  });
});

// ─── An org-scoped key is not the subject's file ─────────────────────────────
//
// collectSubjectFileKeysWithLegalHold falls back to `org_id IN (...)` for tables
// with no foreign key to users. Those keys belong to the tenant, not the subject:
// deleting them on a subject erasure destroys other people's objects.

describe("GdprStoragePurgeService — org-scoped keys are never deleted", () => {
  const USER_KEY: SubjectFileKey = {
    key: "documents/mine.pdf",
    table: "public.hr_documents",
    column: "file_key",
    source: "user-fk",
    orgId: ORG,
  };
  const ORG_KEY: SubjectFileKey = {
    key: "branding/company-logo.png",
    table: "public.organization_settings",
    column: "logo_key",
    source: "org-id",
    orgId: ORG,
  };

  function purgeService(storage: Partial<StorageService>) {
    const db = {
      select: jest.fn().mockReturnValue(chain([])),
      insert: jest.fn().mockReturnValue(chain([{ id: 1 }])),
    };
    return new GdprStoragePurgeService(
      db as unknown as Db,
      storage as StorageService,
    );
  }

  it("(bite proof) deleteFile is called for the user-owned key and never for the org-scoped one", async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const service = purgeService({ deleteFile });

    const result = await service.purgeFromManifest(
      { blocked: false, keys: [USER_KEY, ORG_KEY] },
      SUBJECT,
      ACTOR,
      ORG,
      { dryRun: false },
    );

    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(ORG, USER_KEY.key);
    expect(result.deleted).toEqual([USER_KEY.key]);
    expect(result.skipped).toEqual([
      { key: ORG_KEY.key, reason: "not-subject-attributable-org-scoped-key" },
    ]);
    expect(result.failed).toHaveLength(0);
  });

  it("records the skipped count in the erasure audit", async () => {
    const insertChain = chain([]);
    const db = {
      select: jest.fn().mockReturnValue(chain([])),
      insert: jest.fn().mockReturnValue(insertChain),
    };
    const service = new GdprStoragePurgeService(
      db as unknown as Db,
      { deleteFile: jest.fn().mockResolvedValue(undefined) } as unknown as StorageService,
    );

    await service.purgeFromManifest(
      { blocked: false, keys: [USER_KEY, ORG_KEY] },
      SUBJECT,
      ACTOR,
      ORG,
      { dryRun: false },
    );

    const [values] = insertChain.values.mock.calls[0] as [
      { metadata: { keyCount: number; skippedCount: number; failedCount: number } },
    ];
    expect(values.metadata.keyCount).toBe(1);
    expect(values.metadata.skippedCount).toBe(1);
    expect(values.metadata.failedCount).toBe(0);
  });
});
