import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import {
  markStoresComplete,
  markStoresFailed,
  openMultiStoreLedger,
  purgeChunksForPages,
  purgeGrantsForPages,
  purgeVisitsForPages,
} from "./kb-multi-store-purge";
import { purgeReviewsForPages } from "./kb-purge-reviews";
import { markPurge, openPurgeRecords } from "./kb-purge-ledger";

const ORG = "org-borrow";
const OTHER_ORG = "org-borrow-neighbour";
const PAGES = [901, 902, 903];

function makeTx(): { tx: TenantTx; statements: string[] } {
  const statements: string[] = [];
  const tx = {
    execute: jest.fn(async () => {
      statements.push("execute");
      return [];
    }),
    delete: jest.fn(() => ({
      where: jest.fn(async () => {
        statements.push("delete");
        return [];
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(async () => {
          statements.push("update");
          return [];
        }),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(async () => {
          statements.push("insert");
        }),
        onConflictDoUpdate: jest.fn(async () => {
          statements.push("insert");
        }),
      })),
    })),
  };
  return { tx: tx as unknown as TenantTx, statements };
}

function makeDb(tx: TenantTx): { db: unknown; transaction: jest.Mock } {
  const transaction = jest.fn(
    async (fn: (t: TenantTx) => Promise<unknown>) => fn(tx),
  );
  return { db: { transaction }, transaction };
}

function underCallerTransaction<T>(
  tx: TenantTx,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithTenantContext(
    { orgId: ORG, audience: "INTERNAL", tx, afterCommit: [] },
    fn,
  );
}

describe("a purge running inside a request transaction never borrows a second pooled connection, because ten concurrent purges each waiting for an eleventh connection wedge the pool until the replica restarts", () => {
  it("purgeVisitsForPages writes through the caller's transaction instead of opening its own", async () => {
    const { tx, statements } = makeTx();
    const { db, transaction } = makeDb(tx);

    await underCallerTransaction(tx, () =>
      purgeVisitsForPages(db as never, ORG, PAGES),
    );

    expect(transaction).not.toHaveBeenCalled();
    expect(statements).toEqual(["delete"]);
  });

  it("the same helper does open a transaction when no caller transaction is live, so the assertion above is a property of the ambient context and not of dead code", async () => {
    const { tx, statements } = makeTx();
    const { db, transaction } = makeDb(tx);

    await purgeVisitsForPages(db as never, ORG, PAGES);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(statements).toEqual(["execute", "delete"]);
  });

  it("thirteen store purges and their ledger writes together borrow no connection at all while the caller holds one", async () => {
    const { tx } = makeTx();
    const { db, transaction } = makeDb(tx);

    await underCallerTransaction(tx, async () => {
      await openMultiStoreLedger(db as never, ORG, PAGES);
      await purgeVisitsForPages(db as never, ORG, PAGES);
      await purgeGrantsForPages(db as never, ORG, PAGES);
      await purgeChunksForPages(db as never, ORG, PAGES);
      await purgeReviewsForPages(db as never, ORG, PAGES);
      await markStoresComplete(db as never, ORG, PAGES, "visits");
      await markStoresFailed(db as never, ORG, PAGES, "grants", "boom");
      await openPurgeRecords(db as never, ORG, ["a/b.webp"], "kb:page:purge", "kb");
      await markPurge(db as never, ORG, "a/b.webp", {
        status: "confirmed",
        confirmedAt: new Date(),
        lastAttemptedAt: new Date(),
        failedReason: null,
      });
    });

    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses to purge one organisation's pages inside another organisation's transaction rather than quietly opening a second connection for it", async () => {
    const { tx } = makeTx();
    const { db, transaction } = makeDb(tx);

    await expect(
      underCallerTransaction(tx, () =>
        purgeVisitsForPages(db as never, OTHER_ORG, PAGES),
      ),
    ).rejects.toThrow(OTHER_ORG);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("issues one statement per store for the whole page array, so a hundred-page subtree costs one delete rather than a hundred", async () => {
    const { tx, statements } = makeTx();
    const { db } = makeDb(tx);
    const hundred = Array.from({ length: 100 }, (_v, i) => 1000 + i);

    await underCallerTransaction(tx, async () => {
      await purgeVisitsForPages(db as never, ORG, hundred);
      await markStoresComplete(db as never, ORG, hundred, "visits");
    });

    expect(statements).toEqual(["delete", "update"]);
  });
});
