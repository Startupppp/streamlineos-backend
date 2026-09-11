import { KbIndexingService } from "./kb-indexing.service";

function makeEmbeddings(configured = true) {
  return {
    isEmbeddingConfigured: jest.fn().mockReturnValue(configured),
    embedBatchWithCredit: jest
      .fn()
      .mockImplementation(({ texts }: { texts: string[] }) => Promise.resolve({
        ok: true,
        vectors: texts.map(() => new Array(1536).fill(0.1) as number[]),
      })),
  };
}

function makeCheckpoint() {
  return {
    loadCheckpoints: jest.fn().mockResolvedValue(new Map()),
    saveCheckpoints: jest.fn().mockResolvedValue(undefined),
    clearCheckpoints: jest.fn().mockResolvedValue(undefined),
  };
}

function collectLeaves(node: unknown, seen = new WeakSet<object>()): unknown[] {
  if (node === null || node === undefined || typeof node === "string" || typeof node === "number" || typeof node === "boolean")
    return [node];
  if (typeof node !== "object" || seen.has(node as object)) return [];
  seen.add(node as object);
  return Object.values(node as Record<string, unknown>).flatMap((v) => collectLeaves(v, seen));
}

function makeDb(page: Record<string, unknown> | null) {
  const txDeleteWhere = jest.fn().mockResolvedValue(undefined);
  const txDelete = jest.fn().mockReturnValue({ where: txDeleteWhere });
  const txInsert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });
  const dbDelete = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });

  const query = {
    kbPages: { findFirst: jest.fn().mockResolvedValue(page) },
    kbArticles: { findFirst: jest.fn().mockResolvedValue(page) },
  };
  const select = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    }),
  });

  return {
    db: {
      select,
      delete: dbDelete,
      query,
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn({ delete: txDelete, insert: txInsert, execute: jest.fn().mockResolvedValue([]), query, select }),
      ),
    },
    deleteWhere: txDeleteWhere,
    dbDelete,
    txDelete,
    txInsert,
  };
}

const ORG = "org-1";
const PAGE_ID = 42;

describe("KB lifecycle — de-index on archive or soft-delete", () => {
  it("calls db.delete (removePageChunks) when the page is archived", async () => {
    const { db, txDelete, deleteWhere } = makeDb({
      status: "archived",
      deletedAt: null,
      contentText: "some text",
      visibility: "org",
      projectId: null,
      createdById: "user-1",
      createdByMembershipId: null,
      aclRevision: 1,
      contentRevision: 1,
    });

    const svc = new KbIndexingService(db as never, makeEmbeddings() as never, makeCheckpoint() as never);
    await svc.indexPage(ORG, PAGE_ID);

    expect(txDelete).toHaveBeenCalledTimes(1);
    const whereArg = deleteWhere.mock.calls[0]?.[0];
    const leaves = collectLeaves(whereArg);
    expect(leaves).toContain(ORG);
    expect(leaves).toContain(PAGE_ID);
  });

  it("calls db.delete (removePageChunks) when the page has deletedAt set", async () => {
    const { db, txDelete, deleteWhere } = makeDb({
      status: "published",
      deletedAt: new Date("2026-01-01"),
      contentText: "some content",
      visibility: "org",
      projectId: null,
      createdById: "user-1",
      createdByMembershipId: null,
      aclRevision: 1,
      contentRevision: 1,
    });

    const svc = new KbIndexingService(db as never, makeEmbeddings() as never, makeCheckpoint() as never);
    await svc.indexPage(ORG, PAGE_ID);

    expect(txDelete).toHaveBeenCalledTimes(1);
    const whereArg = deleteWhere.mock.calls[0]?.[0];
    const leaves = collectLeaves(whereArg);
    expect(leaves).toContain(ORG);
    expect(leaves).toContain(PAGE_ID);
  });

  it("does NOT call db.delete directly for an active published page (uses tx.delete inside tx instead)", async () => {
    const { db, dbDelete, txDelete } = makeDb({
      status: "published",
      deletedAt: null,
      contentText: "a page with content to be indexed here",
      visibility: "org",
      projectId: null,
      createdById: "user-1",
      createdByMembershipId: null,
      aclRevision: 1,
      contentRevision: 1,
    });

    const svc = new KbIndexingService(db as never, makeEmbeddings() as never, makeCheckpoint() as never);
    await svc.indexPage(ORG, PAGE_ID);

    expect(dbDelete).not.toHaveBeenCalled();
    expect(txDelete).toHaveBeenCalled();
  });

  it("calls db.delete (removeArticleChunks) for a non-published article", async () => {
    const { db, txDelete, deleteWhere } = makeDb({
      status: "draft",
      contentText: "draft content",
      aclRevision: 1,
      contentRevision: 1,
    });

    const svc = new KbIndexingService(db as never, makeEmbeddings() as never, makeCheckpoint() as never);
    await svc.indexArticle(ORG, PAGE_ID);

    expect(txDelete).toHaveBeenCalledTimes(1);
    const whereArg = deleteWhere.mock.calls[0]?.[0];
    const leaves = collectLeaves(whereArg);
    expect(leaves).toContain(ORG);
    expect(leaves).toContain(PAGE_ID);
  });
});
