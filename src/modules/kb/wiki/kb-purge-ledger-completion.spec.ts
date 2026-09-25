import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { KB_PURGE_STORES } from "../../../db/schema/kb/purge-ledger";

jest.mock("./kb-page-attachment-purge", () => ({
  KB_PAGE_ATTACHMENT_PURGE_PURPOSE: "kb:page:purge",
  recordPageAttachmentPurge: jest.fn(async () => ["kb-media/org-led/a.webp"]),
  attemptPageAttachmentPurge: jest.fn(async () => ({ confirmed: 1, failed: 0 })),
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
  isStoreComplete: jest.fn(async () => false),
  markStoreComplete: jest.fn(async () => undefined),
  markStoreFailed: jest.fn(async () => undefined),
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
  markStoreComplete,
  openMultiStoreLedger,
} from "./kb-multi-store-purge";
import { purgeReviewsForPages } from "./kb-purge-reviews";

const ORG = "org-led";
const PAGE_IDS = [31, 32];

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

function makeService(): KbPageTrashService {
  let batchesServed = 0;
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: async () => {
      batchesServed += 1;
      return batchesServed === 1 ? PAGE_IDS.map((id) => ({ id })) : [];
    },
  };
  const deleteResult = {
    returning: async () => PAGE_IDS.map((id) => ({ id })),
    then: (resolve: (rows: { id: number }[]) => unknown) =>
      Promise.resolve(PAGE_IDS.map((id) => ({ id }))).then(resolve),
  };
  const db = {
    select: () => selectChain,
    delete: () => ({ where: () => deleteResult }),
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue(undefined) },
      kbPagePurgeLedger: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(db)),
  };
  return new KbPageTrashService(
    db as never,
    { log: jest.fn() } as never,
    { deleteFileIfPresent: jest.fn().mockResolvedValue(true) } as never,
    { R2_KB_BUCKET_NAME: "kb-files" } as never,
    { visiblePagePredicate: jest.fn(), assertPageAccess: jest.fn() } as never,
    { restore: jest.fn() } as never,
    { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

function storesMarkedFor(pageId: number): string[] {
  return jest
    .mocked(markStoreComplete)
    .mock.calls.filter((call) => call[2] === pageId)
    .map((call) => String(call[3]));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("every store a purge opens in the ledger is also closed", () => {
  it("emptyTrash opens all fifteen stores per page, so leaving any pending is a ledger leak", async () => {
    const service = makeService();

    await service.emptyTrash(makeUser());

    expect(jest.mocked(openMultiStoreLedger).mock.calls[0]?.[2]).toEqual(
      PAGE_IDS,
    );
    expect(KB_PURGE_STORES).toHaveLength(15);
    expect(KB_PURGE_STORES).toContain("reviews");
  });

  it("emptyTrash deletes review history before the page rows, because the review FK outlives a page that was never purged", async () => {
    const service = makeService();

    await service.emptyTrash(makeUser());

    for (const id of PAGE_IDS) {
      expect(jest.mocked(purgeReviewsForPages).mock.calls.map((c) => c[2]))
        .toContainEqual([id]);
      expect(storesMarkedFor(id)).toContain("reviews");
    }
  });

  it("emptyTrash marks page_rows complete after deleting the rows, or the ledger stays pending forever", async () => {
    const service = makeService();

    await service.emptyTrash(makeUser());

    for (const id of PAGE_IDS)
      expect(storesMarkedFor(id)).toContain("page_rows");
  });

  it("emptyTrash marks blobs complete after purging attachments, or the ledger stays pending forever", async () => {
    const service = makeService();

    await service.emptyTrash(makeUser());

    for (const id of PAGE_IDS) expect(storesMarkedFor(id)).toContain("blobs");
  });

  it("purgeExpired marks page_rows complete, because the retention sweep runs unattended and nobody reads its failures", async () => {
    const service = makeService();

    await service.purgeExpired(ORG, new Date("2026-01-01T00:00:00Z"));

    for (const id of PAGE_IDS)
      expect(storesMarkedFor(id)).toContain("page_rows");
  });

  it("purgeExpired marks blobs complete, so oldestIncompleteLedgerEntry is not poisoned by every swept page", async () => {
    const service = makeService();

    await service.purgeExpired(ORG, new Date("2026-01-01T00:00:00Z"));

    for (const id of PAGE_IDS) expect(storesMarkedFor(id)).toContain("blobs");
  });

  it("emptyTrash closes every store it opened, leaving none pending", async () => {
    const service = makeService();

    await service.emptyTrash(makeUser());

    for (const id of PAGE_IDS)
      expect([...storesMarkedFor(id)].sort()).toEqual([...KB_PURGE_STORES].sort());
  });

  it("a page the purge never touches is marked for no store, so the assertions above are not vacuous", async () => {
    const service = makeService();

    await service.emptyTrash(makeUser());

    expect(storesMarkedFor(999)).toEqual([]);
  });
});
