import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

jest.mock("./kb-page-attachment-purge", () => ({
  KB_PAGE_ATTACHMENT_PURGE_PURPOSE: "kb:page:purge",
  recordPageAttachmentPurge: jest.fn(async () => []),
  attemptPageAttachmentPurge: jest.fn(async () => ({ confirmed: 0, failed: 0 })),
  purgeOrphanedKbMedia: jest.fn(async () => 0),
}));

jest.mock("./kb-purge-reviews", () => ({
  purgeReviewsForPages: jest.fn(async () => undefined),
}));

jest.mock("./kb-multi-store-purge", () => ({
  KB_PURGE_STORES: [
    "visits",
    "favorites",
    "source_links",
    "reviews",
    "versions",
    "comments",
    "grants",
    "chunks",
    "analytics",
    "notifications",
    "caches",
    "public_cdn",
    "connector_projections",
    "page_rows",
    "blobs",
  ],
  openMultiStoreLedger: jest.fn(async () => undefined),
  incompleteStorePages: jest.fn(
    async (_db: unknown, _orgId: string, pageIds: number[]) => pageIds,
  ),
  markStoresComplete: jest.fn(async () => undefined),
  markStoresFailed: jest.fn(async () => undefined),
  purgeVisitsForPages: jest.fn(async () => undefined),
  purgeFavoritesForPages: jest.fn(async () => undefined),
  purgeLinksForPages: jest.fn(async () => undefined),
  purgeVersionsForPages: jest.fn(async () => undefined),
  purgeCommentsForPages: jest.fn(async () => undefined),
  purgeGrantsForPages: jest.fn(async () => undefined),
  purgeChunksForPages: jest.fn(async () => undefined),
  purgeAnalyticsForPages: jest.fn(async () => undefined),
  purgeNotificationsForPages: jest.fn(async () => undefined),
  purgeCachesForPages: jest.fn(async () => undefined),
  purgePublicCdnForPages: jest.fn(async () => undefined),
  purgeConnectorProjectionsForPages: jest.fn(async () => undefined),
}));

import { KbPageTrashService } from "./kb-page-trash.service";
import {
  incompleteStorePages,
  markStoresComplete,
  purgeAnalyticsForPages,
  purgeChunksForPages,
  purgeCommentsForPages,
  purgeFavoritesForPages,
  purgeGrantsForPages,
  purgeLinksForPages,
  purgeNotificationsForPages,
  purgePublicCdnForPages,
  purgeVersionsForPages,
  purgeVisitsForPages,
} from "./kb-multi-store-purge";
import { purgeReviewsForPages } from "./kb-purge-reviews";

const ORG = "org-batch";
const ROOT = 500;
const SUBTREE = [500, 501, 502, 503, 504, 505, 506];

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG,
    isOrgOwner: true,
    role: "owner",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
  };
}

function makeService(subtree: number[]): KbPageTrashService {
  const tx = {
    execute: jest.fn(async () => subtree.map((id) => ({ id }))),
    delete: jest.fn(() => ({ where: jest.fn(async () => []) })),
    select: jest.fn(() => ({ from: () => ({ where: () => ({ for: () => Promise.resolve([]) }) }) })),
  };
  const db = {
    query: {
      kbPages: {
        findFirst: jest.fn().mockResolvedValue({ id: ROOT, title: "Runbook" }),
      },
    },
    transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    select: jest.fn(() => ({ from: () => ({ where: () => Promise.resolve([]) }) })),
  };
  return new KbPageTrashService(
    db as never,
    { log: jest.fn() } as never,
    { deleteFileIfPresent: jest.fn().mockResolvedValue(true) } as never,
    { R2_KB_BUCKET_NAME: "kb-files" } as never,
    {
      visiblePagePredicate: jest.fn().mockResolvedValue(undefined),
      assertPageAccess: jest.fn(),
    } as never,
    { restore: jest.fn() } as never,
    { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

const STORE_PURGES = (): { name: string; fn: jest.Mock }[] => [
  { name: "visits", fn: jest.mocked(purgeVisitsForPages) },
  { name: "favorites", fn: jest.mocked(purgeFavoritesForPages) },
  { name: "source_links", fn: jest.mocked(purgeLinksForPages) },
  { name: "reviews", fn: jest.mocked(purgeReviewsForPages) },
  { name: "versions", fn: jest.mocked(purgeVersionsForPages) },
  { name: "comments", fn: jest.mocked(purgeCommentsForPages) },
  { name: "grants", fn: jest.mocked(purgeGrantsForPages) },
  { name: "chunks", fn: jest.mocked(purgeChunksForPages) },
  { name: "analytics", fn: jest.mocked(purgeAnalyticsForPages) },
  { name: "notifications", fn: jest.mocked(purgeNotificationsForPages) },
  { name: "public_cdn", fn: jest.mocked(purgePublicCdnForPages) },
];

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(incompleteStorePages)
    .mockImplementation(async (_db, _orgId, pageIds) => pageIds);
});

describe("a purge issues one call per store for the whole subtree, because a second pooled connection taken per page per store wedges the pool at ten concurrent purges", () => {
  it("hands every store helper the entire seven-page subtree in a single call, not one call per page", async () => {
    await makeService(SUBTREE).hardDelete(makeUser(), ROOT);

    for (const store of STORE_PURGES()) {
      expect(store.fn.mock.calls.map((call) => call[2])).toEqual([SUBTREE]);
    }
  });

  it("never hands a store helper a single-page array while the subtree holds seven pages, which is exactly what the reverted per-page loop would do", async () => {
    await makeService(SUBTREE).hardDelete(makeUser(), ROOT);

    const singletonCalls = STORE_PURGES().flatMap((store) =>
      store.fn.mock.calls
        .map((call) => call[2] as number[])
        .filter((pageIds) => pageIds.length === 1)
        .map((pageIds) => `${store.name}:${String(pageIds)}`),
    );

    expect(singletonCalls).toEqual([]);
  });

  it("costs the same number of store calls for a seven-page subtree as for a one-page subtree, so the round trips no longer scale with page count", async () => {
    await makeService(SUBTREE).hardDelete(makeUser(), ROOT);
    const wide = STORE_PURGES().reduce(
      (total, store) => total + store.fn.mock.calls.length,
      0,
    );

    jest.clearAllMocks();
    await makeService([ROOT]).hardDelete(makeUser(), ROOT);
    const narrow = STORE_PURGES().reduce(
      (total, store) => total + store.fn.mock.calls.length,
      0,
    );

    expect(wide).toBe(STORE_PURGES().length);
    expect(narrow).toBe(wide);
  });

  it("asks the ledger once per store which pages are still incomplete rather than once per page per store", async () => {
    await makeService(SUBTREE).hardDelete(makeUser(), ROOT);

    const probes = jest.mocked(incompleteStorePages).mock.calls;

    expect(probes).toHaveLength(13);
    expect(probes.map((call) => call[2])).toEqual(
      Array.from({ length: 13 }, () => SUBTREE),
    );
  });

  it("closes every store it opened, marking the whole subtree in one statement per store, so a wide purge cannot leave the ledger pending", async () => {
    await makeService(SUBTREE).hardDelete(makeUser(), ROOT);

    const marked = jest
      .mocked(markStoresComplete)
      .mock.calls.map((call) => [String(call[3]), call[2]] as const);

    expect(marked.map(([store]) => store).sort()).toEqual(
      [
        "analytics",
        "blobs",
        "caches",
        "chunks",
        "comments",
        "connector_projections",
        "favorites",
        "grants",
        "notifications",
        "page_rows",
        "public_cdn",
        "reviews",
        "source_links",
        "versions",
        "visits",
      ].sort(),
    );
    expect(marked.map(([, pageIds]) => pageIds)).toEqual(
      Array.from({ length: 15 }, () => SUBTREE),
    );
  });

  it("skips a store the ledger reports already complete for every page, so a resumed purge does not redo finished work", async () => {
    jest
      .mocked(incompleteStorePages)
      .mockImplementation(async (_db, _orgId, _pageIds, store) =>
        store === "visits" ? [] : SUBTREE,
      );

    await makeService(SUBTREE).hardDelete(makeUser(), ROOT);

    expect(jest.mocked(purgeVisitsForPages)).not.toHaveBeenCalled();
    expect(jest.mocked(purgeFavoritesForPages)).toHaveBeenCalledTimes(1);
  });
});
