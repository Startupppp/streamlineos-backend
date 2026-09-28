import { sql } from "drizzle-orm";
import { ConflictException } from "@nestjs/common";
import { KbPageTrashService } from "./kb-page-trash.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG_ID = "org-hold";
const ROOT_ID = 7;
const HELD_CHILD_ID = 8;

const userInOrg = {
  userId: "user-1",
  orgId: ORG_ID,
  isOrgOwner: false,
} as CurrentUserContext;

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: ORG_ID, pageId: ROOT_ID, action: "view", via: "admin" }),
};

jest.mock("./kb-page-attachment-purge", () => ({
  recordPageAttachmentPurge: jest.fn().mockResolvedValue([]),
  attemptPageAttachmentPurge: jest.fn().mockResolvedValue(undefined),
  purgeOrphanedKbMedia: jest.fn().mockResolvedValue(0),
}));

jest.mock("./kb-multi-store-purge", () => ({
  ...jest.requireActual("./kb-multi-store-purge"),
  openMultiStoreLedger: jest.fn(async () => undefined),
  incompleteStorePages: jest.fn(async (_db: unknown, _orgId: unknown, pageIds: number[]) => pageIds),
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

jest.mock("./kb-purge-reviews", () => ({
  purgeReviewsForPages: jest.fn(async () => undefined),
}));

interface Harness {
  db: Db;
  deletedRowSets: number;
}

function makeDb(heldInSubtree: Array<Record<string, unknown>>): Harness {
  const harness: Harness = { db: undefined as unknown as Db, deletedRowSets: 0 };

  const heldQuery = {
    from: () => heldQuery,
    where: () => heldQuery,
    for: () => heldQuery,
    then: (resolve: (rows: unknown[]) => unknown) => resolve(heldInSubtree),
  };

  const db = {
    query: {
      kbPages: {
        findFirst: jest.fn().mockResolvedValue({
          id: ROOT_ID,
          title: "Root",
          legalHold: false,
          legalHoldReason: null,
        }),
      },
      kbPagePurgeLedger: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    select: jest.fn().mockImplementation(() => heldQuery),
    transaction: jest.fn().mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          execute: jest.fn().mockResolvedValue([{ id: ROOT_ID }, { id: HELD_CHILD_ID }]),
          select: jest.fn().mockImplementation(() => heldQuery),
          delete: () => ({
            where: () => {
              harness.deletedRowSets += 1;
              return Promise.resolve([]);
            },
          }),
          insert: () => ({
            values: () => ({
              onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
            }),
          }),
          update: () => ({ set: () => ({ where: jest.fn().mockResolvedValue([]) }) }),
        }),
    ),
  } as unknown as Db;

  harness.db = db;
  return harness;
}

function service(db: Db): KbPageTrashService {
  return new KbPageTrashService(
    db,
    { log: jest.fn() } as never,
    {} as never,
    { R2_KB_BUCKET_NAME: "test-bucket" } as never,
    auth as never,
    { restore: jest.fn().mockResolvedValue({ id: ROOT_ID }) } as never,
    { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

import { openMultiStoreLedger } from "./kb-multi-store-purge";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("legal hold covers the whole subtree, not just the page named in the request", () => {
  it("refuses to hard-delete an unheld parent whose descendant is under a legal hold, because collectSubtreeIds deletes descendants and a hold on one of them is unrecoverable once the rows are gone", async () => {
    const harness = makeDb([
      { id: HELD_CHILD_ID, title: "Held child", legalHoldReason: "Litigation" },
    ]);

    await expect(
      service(harness.db).hardDelete(userInOrg, ROOT_ID),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(harness.deletedRowSets).toBe(0);
  });

  it("CONTROL: hard-deletes the same unheld parent when no descendant is held, so the refusal above is the hold and not a blanket block", async () => {
    const harness = makeDb([]);

    await expect(
      service(harness.db).hardDelete(userInOrg, ROOT_ID),
    ).resolves.not.toThrow();

    expect(harness.deletedRowSets).toBeGreaterThan(0);
  });
});

describe("hold check runs before any multi-store ledger entry is opened or store purge runs", () => {
  it("does not open the purge ledger when a held descendant stops the delete — no store is touched before the hold check rejects", async () => {
    const harness = makeDb([
      { id: HELD_CHILD_ID, title: "Held child", legalHoldReason: "Litigation" },
    ]);

    await expect(
      service(harness.db).hardDelete(userInOrg, ROOT_ID),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(jest.mocked(openMultiStoreLedger)).not.toHaveBeenCalled();
  });

  it("CONTROL: opens the purge ledger when no hold stops the delete, proving the assertion above is not vacuous", async () => {
    const harness = makeDb([]);

    await service(harness.db).hardDelete(userInOrg, ROOT_ID);

    expect(jest.mocked(openMultiStoreLedger)).toHaveBeenCalledTimes(1);
  });
});
