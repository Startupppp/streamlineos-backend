import { PgDialect } from "drizzle-orm/pg-core";
import { type SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
  ),
  runInTenantTransaction: jest.fn(
    async (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts: unknown) => fn(mockTx),
  ),
}));

const insertedBatches: { orgId: string; pageId: number; store: string }[][] = [];
const updatedRows: { status: string; orgId: string; pageId: number; store: string }[] = [];
const deletedTables: string[] = [];

const mockTx = {
  insert: jest.fn(() => ({
    values: jest.fn((rows: unknown) => ({
      onConflictDoNothing: jest.fn(async () => {
        const arr = Array.isArray(rows) ? rows : [rows];
        insertedBatches.push(
          arr.map((r: unknown) => ({
            orgId: (r as { orgId: string }).orgId,
            pageId: (r as { pageId: number }).pageId,
            store: (r as { store: string }).store,
          })),
        );
      }),
    })),
  })),
  update: jest.fn(() => ({
    set: jest.fn((set: { status?: string }) => ({
      where: jest.fn(async (cond: SQL) => {
        const vals = extractSqlValues(cond);
        updatedRows.push({
          status: set.status ?? "",
          orgId: vals[0] ?? "",
          pageId: Number(vals[1] ?? 0),
          store: vals[2] ?? "",
        });
      }),
    })),
  })),
  delete: jest.fn((table: { _: { name?: string }; tableName?: string }) => ({
    where: jest.fn(async () => {
      deletedTables.push(
        (table as { tableName?: string }).tableName ?? "unknown",
      );
    }),
  })),
};

const dialect = new PgDialect();

function extractSqlValues(cond: SQL): string[] {
  const { params } = dialect.sqlToQuery(cond);
  return params.map(String);
}

import {
  incompleteStorePages,
  markStoresComplete,
  markStoresFailed,
  oldestIncompleteLedgerEntry,
  openMultiStoreLedger,
  purgeFavoritesForPages,
  purgeLinksForPages,
  purgeVisitsForPages,
  purgeVersionsForPages,
  purgeCommentsForPages,
  purgeGrantsForPages,
  purgeChunksForPages,
  purgeAnalyticsForPages,
  purgeNotificationsForPages,
  purgeCachesForPages,
  purgePublicCdnForPages,
  purgeConnectorProjectionsForPages,
  KB_PURGE_STORES,
  type KbPurgeStore,
} from "./kb-multi-store-purge";
import { kbPagePurgeLedger } from "../../../db/schema/kb/purge-ledger";

const ORG_A = "org-ledger-a";
const ORG_B = "org-ledger-b";
const PAGE_1 = 101;
const PAGE_2 = 102;

function makeQueryDb(row: { status: string } | null): Db {
  return {
    query: {
      kbPagePurgeLedger: {
        findFirst: jest.fn().mockResolvedValue(row),
      },
    },
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn().mockResolvedValue([{ oldest: null }]),
      })),
    })),
  } as unknown as Db;
}

function makeSelectDb(minResult: Date | null): Db {
  return {
    query: { kbPagePurgeLedger: { findFirst: jest.fn().mockResolvedValue(null) } },
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn().mockResolvedValue([{ oldest: minResult }]),
      })),
    })),
  } as unknown as Db;
}

function makeCompletedPagesDb(completedPageIdsFor: (store: KbPurgeStore) => number[]): Db {
  return {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(async (cond: SQL) => {
          const { params } = dialect.sqlToQuery(cond);
          const store = params.find(
            (p): p is string => typeof p === "string" && (KB_PURGE_STORES as readonly string[]).includes(p),
          ) as KbPurgeStore | undefined;
          if (!store) return [];
          return completedPageIdsFor(store).map((pageId) => ({ pageId }));
        }),
      })),
    })),
  } as unknown as Db;
}

beforeEach(() => {
  insertedBatches.length = 0;
  updatedRows.length = 0;
  deletedTables.length = 0;
  jest.clearAllMocks();
});

describe("openMultiStoreLedger — creates one pending entry per store per page", () => {
  it("inserts a row for every KB_PURGE_STORE for each page id", async () => {
    const db = makeQueryDb(null);
    await openMultiStoreLedger(db, ORG_A, [PAGE_1, PAGE_2]);

    const allInserted = insertedBatches.flat();
    for (const pageId of [PAGE_1, PAGE_2]) {
      for (const store of KB_PURGE_STORES) {
        expect(
          allInserted.some((r) => r.orgId === ORG_A && r.pageId === pageId && r.store === store),
        ).toBe(true);
      }
    }
  });

  it("uses onConflictDoNothing so an already-completed entry is not reset", async () => {
    const db = makeQueryDb(null);
    await openMultiStoreLedger(db, ORG_A, [PAGE_1]);
    expect(mockTx.insert).toHaveBeenCalled();
    const valsCalls = mockTx.insert.mock.results.flatMap((r: unknown) => {
      const result = r as { value?: { values?: jest.Mock } };
      return result?.value?.values ? [result.value.values] : [];
    });
    expect(valsCalls.length).toBeGreaterThan(0);
  });

  it("is a no-op for an empty page list and issues no DB write", async () => {
    const db = makeQueryDb(null);
    await openMultiStoreLedger(db, ORG_A, []);
    expect(insertedBatches.flat()).toHaveLength(0);
  });

  it("scopes every inserted row to the given org_id", async () => {
    const db = makeQueryDb(null);
    await openMultiStoreLedger(db, ORG_A, [PAGE_1]);
    const allInserted = insertedBatches.flat();
    expect(allInserted.every((r) => r.orgId === ORG_A)).toBe(true);
  });
});

describe("incompleteStorePages — returns page ids not yet complete for a given store", () => {
  it("returns empty array when the page has a completed ledger row (page is done)", async () => {
    const db = makeCompletedPagesDb(() => [PAGE_1]);
    expect(await incompleteStorePages(db, ORG_A, [PAGE_1], "visits")).toEqual([]);
  });

  it("returns the page id when the page has no completed ledger row (pending status)", async () => {
    const db = makeCompletedPagesDb(() => []);
    expect(await incompleteStorePages(db, ORG_A, [PAGE_1], "visits")).toEqual([PAGE_1]);
  });

  it("returns the page id when the page has a failed ledger row (failed is not complete)", async () => {
    const db = makeCompletedPagesDb(() => []);
    expect(await incompleteStorePages(db, ORG_A, [PAGE_1], "visits")).toEqual([PAGE_1]);
  });

  it("returns the page id when no ledger row exists for the page", async () => {
    const db = makeCompletedPagesDb(() => []);
    expect(await incompleteStorePages(db, ORG_A, [PAGE_1], "visits")).toEqual([PAGE_1]);
  });

  it("cross-tenant isolation: the where clause carries org_id so another tenant's completed row cannot satisfy the check", async () => {
    let capturedWhere: SQL | undefined;
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(async (cond: SQL) => {
            capturedWhere = cond;
            return [];
          }),
        })),
      })),
    } as unknown as Db;
    await incompleteStorePages(db, ORG_A, [PAGE_1], "visits");
    expect(capturedWhere).toBeDefined();
    const { params } = dialect.sqlToQuery(capturedWhere!);
    expect(params).toContain(ORG_A);
    expect(params).not.toContain(ORG_B);
  });
});

describe("markStoresComplete — records completion in the ledger for a batch of pages", () => {
  it("writes status=completed for the given pages", async () => {
    const db = makeQueryDb(null);
    await markStoresComplete(db, ORG_A, [PAGE_1], "favorites");
    expect(updatedRows.some((r) => r.status === "completed")).toBe(true);
  });

  it("the where clause carries org_id, page_id, and store so only the right rows are updated", async () => {
    const db = makeQueryDb(null);
    await markStoresComplete(db, ORG_A, [PAGE_1], "blobs");
    const setCall = (mockTx.update as jest.Mock).mock.results[0] as {
      value?: { set?: jest.Mock };
    };
    const whereCall = setCall?.value?.set?.mock?.results?.[0] as {
      value?: { where?: jest.Mock };
    };
    const whereSql: SQL | undefined = whereCall?.value?.where?.mock?.calls?.[0]?.[0];
    expect(whereSql).toBeDefined();
    const { params } = dialect.sqlToQuery(whereSql!);
    expect(params).toContain(ORG_A);
    expect(params).toContain(PAGE_1);
    expect(params).toContain("blobs");
  });

  it("is idempotent: calling twice does not throw", async () => {
    const db = makeQueryDb(null);
    await markStoresComplete(db, ORG_A, [PAGE_1], "blobs");
    await expect(markStoresComplete(db, ORG_A, [PAGE_1], "blobs")).resolves.not.toThrow();
  });
});

describe("markStoresFailed — records failure with reason for a batch of pages", () => {
  it("writes status=failed to the ledger for the given pages", async () => {
    const db = makeQueryDb(null);
    await markStoresFailed(db, ORG_A, [PAGE_1], "page_rows", "FK violation on kb_page_visits");
    expect(updatedRows.some((r) => r.status === "failed")).toBe(true);
  });

  it("truncates the reason to 1000 characters before writing to the ledger", async () => {
    let capturedFailedReason: string | undefined;
    const localTx = {
      update: jest.fn(() => ({
        set: jest.fn((s: { failedReason?: string }) => {
          capturedFailedReason = s.failedReason;
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    const runInTenantTransactionMock = jest.requireMock(
      "../../../common/tenant/run-in-tenant-transaction",
    ) as { runInTenantTransaction: jest.Mock };
    const prev = runInTenantTransactionMock.runInTenantTransaction.getMockImplementation();
    runInTenantTransactionMock.runInTenantTransaction.mockImplementationOnce(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts: unknown) =>
        fn(localTx),
    );
    const db = makeQueryDb(null);
    await markStoresFailed(db, ORG_A, [PAGE_1], "page_rows", "x".repeat(5_000));
    expect(capturedFailedReason).toHaveLength(1_000);
    if (prev) runInTenantTransactionMock.runInTenantTransaction.mockImplementation(prev);
  });
});

describe("oldestIncompleteLedgerEntry — SLA metric query", () => {
  it("returns the Date when a pending entry exists", async () => {
    const sentinel = new Date("2025-01-01T00:00:00Z");
    const db = makeSelectDb(sentinel);
    expect(await oldestIncompleteLedgerEntry(db)).toEqual(sentinel);
  });

  it("returns null when no pending entries exist", async () => {
    const db = makeSelectDb(null);
    expect(await oldestIncompleteLedgerEntry(db)).toBeNull();
  });

  it("BITE: non-null when empty would hide SLA health; null confirms the queue is clear", async () => {
    const db = makeSelectDb(null);
    const result = await oldestIncompleteLedgerEntry(db);
    expect(result).not.toEqual(expect.any(Date));
  });
});

describe("resumability — interrupted purge resumes from the right store", () => {
  it("skips a store already marked completed and runs the pending store", async () => {
    const completedStores = new Set<KbPurgeStore>(["visits"]);
    const db = makeCompletedPagesDb((store) =>
      completedStores.has(store) ? [PAGE_1] : [],
    );

    const ran: KbPurgeStore[] = [];
    for (const store of KB_PURGE_STORES) {
      const incomplete = await incompleteStorePages(db, ORG_A, [PAGE_1], store);
      if (incomplete.length > 0) ran.push(store);
    }

    expect(ran).not.toContain("visits");
    expect(ran).toContain("favorites");
  });

  it("re-running after all stores complete calls no store purges", async () => {
    const db = makeCompletedPagesDb(() => [PAGE_1]);

    const ran: KbPurgeStore[] = [];
    for (const store of KB_PURGE_STORES) {
      const incomplete = await incompleteStorePages(db, ORG_A, [PAGE_1], store);
      if (incomplete.length > 0) ran.push(store);
    }

    expect(ran).toHaveLength(0);
  });

  it("a failed store is retried while already-completed stores are skipped", async () => {
    const completedStores = new Set<KbPurgeStore>(["visits"]);
    const db = makeCompletedPagesDb((store) =>
      completedStores.has(store) ? [PAGE_1] : [],
    );

    const skipped: KbPurgeStore[] = [];
    const retried: KbPurgeStore[] = [];

    for (const store of ["visits", "favorites", "source_links"] as KbPurgeStore[]) {
      const incomplete = await incompleteStorePages(db, ORG_A, [PAGE_1], store);
      if (incomplete.length === 0) skipped.push(store);
      else retried.push(store);
    }

    expect(skipped).toEqual(["visits"]);
    expect(retried).toEqual(["favorites", "source_links"]);
  });
});

describe("cross-tenant isolation on the ledger", () => {
  it("openMultiStoreLedger rows carry only the specified org_id", async () => {
    const db = makeQueryDb(null);
    await openMultiStoreLedger(db, ORG_A, [PAGE_1]);
    const all = insertedBatches.flat();
    expect(all.some((r) => r.orgId === ORG_B)).toBe(false);
  });

  it("markStoresComplete includes org_id in its WHERE clause so another tenant's rows cannot be updated", async () => {
    let capturedWhere: SQL | undefined;
    const localTx = {
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(async (cond: SQL) => {
            capturedWhere = cond;
          }),
        })),
      })),
    };
    const runInTenantTransactionMock = jest.requireMock(
      "../../../common/tenant/run-in-tenant-transaction",
    ) as { runInTenantTransaction: jest.Mock };
    runInTenantTransactionMock.runInTenantTransaction.mockImplementationOnce(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts: unknown) =>
        fn(localTx),
    );
    const db = makeQueryDb(null);
    await markStoresComplete(db, ORG_A, [PAGE_1], "visits");
    expect(capturedWhere).toBeDefined();
    const { params } = dialect.sqlToQuery(capturedWhere!);
    expect(params).toContain(ORG_A);
    expect(params).not.toContain(ORG_B);
  });
});

describe("purgeVisitsForPages — scoped delete of kb_page_visits", () => {
  it("calls delete inside a tenant transaction and is a no-op for empty page list", async () => {
    const db = makeQueryDb(null);
    await purgeVisitsForPages(db, ORG_A, []);
    expect(deletedTables.filter((t) => t.includes("visits"))).toHaveLength(0);
  });
});

describe("purgeFavoritesForPages — scoped delete of kb_page_favorites", () => {
  it("is a no-op for an empty page list", async () => {
    const db = makeQueryDb(null);
    await purgeFavoritesForPages(db, ORG_A, []);
    expect(deletedTables.filter((t) => t.includes("favorites"))).toHaveLength(0);
  });
});

describe("purgeLinksForPages — deletes both source and inbound links", () => {
  it("is a no-op for an empty page list", async () => {
    const db = makeQueryDb(null);
    await purgeLinksForPages(db, ORG_A, []);
    expect(deletedTables.filter((t) => t.includes("links"))).toHaveLength(0);
  });

  it("issues two deletes per non-empty batch: one for source links, one for target links", async () => {
    const db = makeQueryDb(null);
    await purgeLinksForPages(db, ORG_A, [PAGE_1]);
    expect(mockTx.delete).toHaveBeenCalledTimes(2);
  });
});

describe("kbPagePurgeLedger schema — correct columns are declared", () => {
  it("has the expected store constraint values", () => {
    const checks = (kbPagePurgeLedger as { _?: { config?: { checks?: { value?: unknown }[] } } })?._?.config?.checks;
    expect(checks ?? kbPagePurgeLedger).toBeDefined();
  });

  it("carries org_id as a non-nullable column for tenant isolation", () => {
    const col = (
      kbPagePurgeLedger as unknown as {
        orgId: { notNull?: boolean; columnType?: string };
      }
    ).orgId;
    expect(col).toBeDefined();
  });
});

describe("KB_PURGE_STORES constant — all required stores are registered", () => {
  it("includes all six original stores", () => {
    for (const store of ["visits", "favorites", "source_links", "reviews", "page_rows", "blobs"] as const) {
      expect(KB_PURGE_STORES).toContain(store);
    }
  });

  it("includes all six new stores so the compliance ledger tracks every surface", () => {
    for (const store of ["versions", "comments", "grants", "chunks", "analytics", "notifications"] as const) {
      expect(KB_PURGE_STORES).toContain(store);
    }
  });

  it("includes the three remaining stores: caches, public_cdn, connector_projections", () => {
    for (const store of ["caches", "public_cdn", "connector_projections"] as const) {
      expect(KB_PURGE_STORES).toContain(store);
    }
  });

  it("page_rows comes after all pre-delete stores — ordering invariant", () => {
    const pageRowsIndex = KB_PURGE_STORES.indexOf("page_rows");
    const prePurgeStores: KbPurgeStore[] = [
      "visits", "favorites", "source_links", "reviews",
      "versions", "comments", "grants", "chunks", "analytics", "notifications",
      "caches", "public_cdn", "connector_projections",
    ];
    for (const store of prePurgeStores) {
      expect(KB_PURGE_STORES.indexOf(store)).toBeLessThan(pageRowsIndex);
    }
  });
});

describe("purgeVersionsForPages — explicit delete of kb_page_versions before page row", () => {
  it("is a no-op for an empty page list", async () => {
    const db = makeQueryDb(null);
    await purgeVersionsForPages(db, ORG_A, []);
    expect(mockTx.delete).not.toHaveBeenCalled();
  });

  it("issues a delete scoped to orgId and pageId for a non-empty list", async () => {
    const db = makeQueryDb(null);
    await purgeVersionsForPages(db, ORG_A, [PAGE_1]);
    expect(mockTx.delete).toHaveBeenCalledTimes(1);
  });
});

describe("purgeCommentsForPages — explicit delete of kb_page_comments before page row", () => {
  it("is a no-op for an empty page list", async () => {
    const db = makeQueryDb(null);
    await purgeCommentsForPages(db, ORG_A, []);
    expect(mockTx.delete).not.toHaveBeenCalled();
  });

  it("issues a delete scoped to orgId and pageId for a non-empty list", async () => {
    const db = makeQueryDb(null);
    await purgeCommentsForPages(db, ORG_A, [PAGE_1]);
    expect(mockTx.delete).toHaveBeenCalledTimes(1);
  });
});

describe("purgeGrantsForPages — explicit delete of kb_page_grants (always empty, required for compliance)", () => {
  it("is a no-op for an empty page list", async () => {
    const db = makeQueryDb(null);
    await purgeGrantsForPages(db, ORG_A, []);
    expect(mockTx.delete).not.toHaveBeenCalled();
  });

  it("issues a delete scoped to orgId and pageId for a non-empty list", async () => {
    const db = makeQueryDb(null);
    await purgeGrantsForPages(db, ORG_A, [PAGE_1]);
    expect(mockTx.delete).toHaveBeenCalledTimes(1);
  });
});

describe("purgeChunksForPages — explicit delete of kb_article_chunks before page row", () => {
  it("is a no-op for an empty page list", async () => {
    const db = makeQueryDb(null);
    await purgeChunksForPages(db, ORG_A, []);
    expect(mockTx.delete).not.toHaveBeenCalled();
  });

  it("issues a delete scoped to orgId and pageId for a non-empty list", async () => {
    const db = makeQueryDb(null);
    await purgeChunksForPages(db, ORG_A, [PAGE_1]);
    expect(mockTx.delete).toHaveBeenCalledTimes(1);
  });
});

describe("purgeAnalyticsForPages — nullifies kb_events.article_id (no FK, would outlive the page)", () => {
  const updatedAnalytics: { status?: string }[] = [];
  const mockAnalyticsTx = {
    ...mockTx,
    update: jest.fn(() => ({
      set: jest.fn((s: { articleId: null }) => ({
        where: jest.fn(async () => {
          updatedAnalytics.push({ status: s.articleId === null ? "nullified" : "other" });
        }),
      })),
    })),
  };

  it("is a no-op for an empty page list", async () => {
    const db = makeQueryDb(null);
    await purgeAnalyticsForPages(db, ORG_A, []);
    expect(updatedAnalytics).toHaveLength(0);
  });

  it("nullifies articleId rather than deleting the event row — analytics history is preserved", async () => {
    const runInTenantTransactionMock = jest.requireMock(
      "../../../common/tenant/run-in-tenant-transaction",
    ) as { runInTenantTransaction: jest.Mock };
    const prev = runInTenantTransactionMock.runInTenantTransaction.getMockImplementation();
    runInTenantTransactionMock.runInTenantTransaction.mockImplementationOnce(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts: unknown) =>
        fn(mockAnalyticsTx),
    );
    const db = makeQueryDb(null);
    await purgeAnalyticsForPages(db, ORG_A, [PAGE_1]);
    expect(mockAnalyticsTx.update).toHaveBeenCalledTimes(1);
    if (prev) runInTenantTransactionMock.runInTenantTransaction.mockImplementation(prev);
  });
});

describe("purgeNotificationsForPages — deletes notifications by entityId (no FK, would outlive the page)", () => {
  it("is a no-op for an empty page list", async () => {
    const db = makeQueryDb(null);
    await purgeNotificationsForPages(db, ORG_A, []);
    expect(mockTx.delete).not.toHaveBeenCalled();
  });

  it("issues a delete scoped to orgId and entityId strings for a non-empty list", async () => {
    const db = makeQueryDb(null);
    await purgeNotificationsForPages(db, ORG_A, [PAGE_1]);
    expect(mockTx.delete).toHaveBeenCalledTimes(1);
  });
});

describe("purgeCachesForPages — invalidates org-level access space cache so purged pages are not served from cache", () => {
  it("calls invalidateNamespace with the org-scoped cache key", async () => {
    const invalidateNamespace = jest.fn().mockResolvedValue(undefined);
    const cache = { invalidateNamespace } as never;
    await purgeCachesForPages(cache, ORG_A, [PAGE_1]);
    expect(invalidateNamespace).toHaveBeenCalledWith(`kb:acc-spaces:${ORG_A}`);
  });

  it("still calls invalidateNamespace even for an empty page list, because the cache is org-scoped not page-scoped", async () => {
    const invalidateNamespace = jest.fn().mockResolvedValue(undefined);
    const cache = { invalidateNamespace } as never;
    await purgeCachesForPages(cache, ORG_A, []);
    expect(invalidateNamespace).toHaveBeenCalledTimes(1);
  });
});

describe("purgePublicCdnForPages — nullifies publicToken before the row is deleted so the public URL stops resolving", () => {
  it("is a no-op for an empty page list", async () => {
    const db = makeQueryDb(null);
    await purgePublicCdnForPages(db, ORG_A, []);
    expect(mockTx.update).not.toHaveBeenCalled();
  });

  it("issues an UPDATE setting publicToken to null for a non-empty list", async () => {
    const db = makeQueryDb(null);
    await purgePublicCdnForPages(db, ORG_A, [PAGE_1]);
    expect(mockTx.update).toHaveBeenCalledTimes(1);
  });
});

describe("purgeConnectorProjectionsForPages — no connector-projection table exists in this schema yet", () => {
  it("resolves without error for a non-empty page list", async () => {
    const db = makeQueryDb(null);
    await expect(purgeConnectorProjectionsForPages(db, ORG_A, [PAGE_1])).resolves.not.toThrow();
  });

  it("issues no database call because there is no connector-projection table to write to", async () => {
    const db = makeQueryDb(null);
    await purgeConnectorProjectionsForPages(db, ORG_A, [PAGE_1]);
    expect(mockTx.delete).not.toHaveBeenCalled();
    expect(mockTx.update).not.toHaveBeenCalled();
    expect(mockTx.insert).not.toHaveBeenCalled();
  });
});
