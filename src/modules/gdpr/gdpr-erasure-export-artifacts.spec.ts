import { CacheService } from "../../common/cache/cache.service";
import { gdprExportJobs, hrLegalHolds, organizationMembers } from "../../db/schema";
import { EXPORT_ARTIFACT_PAGE } from "./gdpr-subject-erasure-export-artifacts";
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

// ─── The subject's own export archive outlived their erasure ─────────────────
//
// MECHANISM: `collectSubjectFileKeysWithLegalHold` attributes an object to a subject only
// through a real foreign key to `public.users`. `gdpr_export_jobs.subject_user_id` is a
// bare `text` column with no constraint, so the table was classified `org-id` — and
// `purgeFromManifest` skips `org-id` keys deliberately, to avoid destroying a third
// party's object. The consequence was that erasing a subject left a complete JSON dump of
// their personal data alive in the bucket, and (with `expireOldJobs` uncalled) still
// marked `completed`.
//
// Every fixture is LARGER than EXPORT_ARTIFACT_PAGE. A fixture that fits in one page
// cannot tell a keyset drain from a `.limit(n)` cap, which is the defect this ticket has
// shipped twice already.

const ORG = "org-artifact";
const SUBJECT = "user-artifact-subject";
const ACTOR = "user-artifact-actor";
const ARTIFACT_COUNT = EXPORT_ARTIFACT_PAGE * 2 + 13;

interface Store {
  artifacts: Array<{ id: string; fileKey: string }>;
  legalHolds: Array<{ id: number; reason: string }>;
  artifactSelectCalls: number;
  exportSetPayloads: Array<Record<string, unknown>>;
  callOrder: string[];
}

function artifactId(i: number): string {
  return `job-${String(i).padStart(6, "0")}`;
}

function makeStore(artifacts: number): Store {
  return {
    artifacts: Array.from({ length: artifacts }, (_, i) => ({
      id: artifactId(i),
      fileKey: `gdpr-exports/${artifactId(i)}.json`,
    })),
    legalHolds: [],
    artifactSelectCalls: 0,
    exportSetPayloads: [],
    callOrder: [],
  };
}

/** Mirrors the keyset predicate: everything strictly after the cursor, one page at a time. */
function makeDb(store: Store) {
  let artifactCursor: string | null = null;

  const dbSelectChain = () => {
    let table: unknown = null;
    const resolve = (): unknown[] => {
      if (table === organizationMembers) return [{ id: 77 }];
      if (table === hrLegalHolds) return store.legalHolds;
      if (table === gdprExportJobs) {
        store.callOrder.push("collect.gdpr_export_jobs");
        store.artifactSelectCalls += 1;
        const rows = store.artifacts
          .filter((a) => artifactCursor === null || a.id > artifactCursor)
          .slice(0, EXPORT_ARTIFACT_PAGE);
        const last = rows[rows.length - 1];
        if (last) artifactCursor = last.id;
        return rows;
      }
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

  const txSelectChain = () => {
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
    let values: Record<string, unknown> = {};
    const apply = (): unknown[] => {
      if (table === gdprExportJobs) {
        store.callOrder.push("tx.gdpr_export_jobs.update");
        store.exportSetPayloads.push(values);
        return store.artifacts.map((a) => ({ id: a.id }));
      }
      return [];
    };
    const chain = {
      set: (v: Record<string, unknown>) => {
        values = v;
        return chain;
      },
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

  const emptyChain = () => {
    const chain = {
      // The surviving-membership guard joins organizations to exclude deleted orgs;
      // the double models a builder, so it needs the link the query now walks.
      innerJoin: () => chain,
      where: () => chain,
      returning: () => Promise.resolve([]),
      then: (onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(onOk, onErr),
    };
    return chain;
  };

  const tx = {
    select: jest.fn(() => txSelectChain()),
    update: jest.fn((t: unknown) => updateChain(t)),
    delete: jest.fn(() => emptyChain()),
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

function makePurgeDouble() {
  return {
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

interface ManifestKey {
  key: string;
  table: string;
  source: string;
  orgId: string | null;
}

function manifestKeys(purge: ReturnType<typeof makePurgeDouble>): ManifestKey[] {
  const call = purge.purgeFromManifest.mock.calls[0];
  const manifest = call?.[0] as { keys: ManifestKey[] } | undefined;
  return manifest?.keys ?? [];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GdprSubjectErasureService — the subject's export archives are purged", () => {
  it("drains every page of gdpr_export_jobs and hands each key to the purge", async () => {
    const store = makeStore(ARTIFACT_COUNT);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(store.artifactSelectCalls).toBe(3);
    expect(manifestKeys(purge)).toHaveLength(ARTIFACT_COUNT);
    expect(manifestKeys(purge).map((k) => k.key)).toContain(
      `gdpr-exports/${artifactId(ARTIFACT_COUNT - 1)}.json`,
    );
  });

  it("(bite proof) a single short page yields one select — the multi-page count is not an artefact", async () => {
    const store = makeStore(7);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(store.artifactSelectCalls).toBe(1);
    expect(manifestKeys(purge)).toHaveLength(7);
  });

  it("marks them user-fk, not org-id — purgeFromManifest SKIPS org-id keys by design", async () => {
    const store = makeStore(3);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    for (const key of manifestKeys(purge)) {
      expect(key.source).toBe("user-fk");
      expect(key.table).toBe("public.gdpr_export_jobs");
      expect(key.orgId).toBe(ORG);
    }
  });

  it("(bite proof) a subject with no artifacts contributes no manifest key", async () => {
    const store = makeStore(0);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(manifestKeys(purge)).toHaveLength(0);
  });

  it("collects the keys BEFORE the transaction — a row retired first would orphan its object", async () => {
    const store = makeStore(2);
    const { db } = makeDb(store);

    await buildService(db, makePurgeDouble()).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: false,
    });

    expect(store.callOrder.indexOf("collect.gdpr_export_jobs")).toBeGreaterThanOrEqual(0);
    expect(store.callOrder.indexOf("collect.gdpr_export_jobs")).toBeLessThan(
      store.callOrder.indexOf("db.transaction"),
    );
  });

  it("keeps file_key on the retired job so a failed object delete is retried, not orphaned", async () => {
    const store = makeStore(2);
    const { db } = makeDb(store);

    await buildService(db, makePurgeDouble()).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: false,
    });

    expect(store.exportSetPayloads).toHaveLength(1);
    const payload = store.exportSetPayloads[0] ?? {};
    expect(payload).toMatchObject({ status: "expired", fileName: null });
    expect(Object.keys(payload)).not.toContain("fileKey");
    expect(payload["expiresAt"]).toBeInstanceOf(Date);
  });

  it("reports gdpr_export_jobs in tablesAnonymised when artifacts were retired", async () => {
    const store = makeStore(2);
    const { db } = makeDb(store);

    const result = await buildService(db, makePurgeDouble()).eraseSubject(
      SUBJECT,
      ORG,
      ACTOR,
      { dryRun: false },
    );

    expect(result.tablesAnonymised).toContain("gdpr_export_jobs");
  });
});

describe("GdprSubjectErasureService — legal hold blocks the artifact sink too", () => {
  it("collects nothing and purges nothing when an active hold exists", async () => {
    const store = makeStore(5);
    store.legalHolds = [{ id: 9, reason: "litigation-hold" }];
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    const result = await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: false,
    });

    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe("litigation-hold");
    expect(store.artifactSelectCalls).toBe(0);
    expect(purge.buildManifest).not.toHaveBeenCalled();
    expect(purge.purgeFromManifest).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("(bite proof) with the hold released the same fixture DOES collect and purge", async () => {
    const store = makeStore(5);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    const result = await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: false,
    });

    expect(result.blocked).toBe(false);
    expect(store.artifactSelectCalls).toBe(1);
    expect(manifestKeys(purge)).toHaveLength(5);
  });

  it("a blocked manifest contributes no artifact keys either", async () => {
    const store = makeStore(5);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();
    purge.buildManifest.mockResolvedValue({
      blocked: true,
      blockReason: "active-legal-hold",
      keys: [],
    });

    await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(store.artifactSelectCalls).toBe(0);
    expect(manifestKeys(purge)).toHaveLength(0);
  });
});

describe("GdprSubjectErasureService — the artifact sink is idempotent", () => {
  it("a second run over an already-purged subject claims the table and adds no key", async () => {
    const first = makeStore(3);
    const firstResult = await buildService(makeDb(first).db, makePurgeDouble()).eraseSubject(
      SUBJECT,
      ORG,
      ACTOR,
      { dryRun: false },
    );

    const second = makeStore(0);
    const purge = makePurgeDouble();
    const result = await buildService(makeDb(second).db, purge).eraseSubject(
      SUBJECT,
      ORG,
      ACTOR,
      { dryRun: false },
    );

    expect(firstResult.tablesAnonymised).toContain("gdpr_export_jobs");
    expect(result.tablesAnonymised).not.toContain("gdpr_export_jobs");
    expect(manifestKeys(purge)).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });

  it("declares the table in a dry run, sizes the manifest and writes nothing", async () => {
    const store = makeStore(4);
    const { db } = makeDb(store);
    const purge = makePurgeDouble();

    const result = await buildService(db, purge).eraseSubject(SUBJECT, ORG, ACTOR, {
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.tablesAnonymised).toContain("gdpr_export_jobs");
    expect(result.storage.manifestSize).toBe(4);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(purge.purgeFromManifest).not.toHaveBeenCalled();
  });
});
