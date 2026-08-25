import { createHash } from "node:crypto";
import { KbIndexingService } from "./kb-indexing.service";

const EMBEDDING_DIM = 1536;

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const makeEmbeddings = (configured = true) => ({
  isConfigured: jest.fn().mockReturnValue(configured),
  embedQuery: jest.fn().mockResolvedValue(new Array(EMBEDDING_DIM).fill(0.1)),
  toVectorLiteral: jest.fn((v: number[]) => `[${v.join(",")}]`),
});

const makeStorage = () => ({});

interface MockTx {
  delete: jest.Mock;
  where: jest.Mock;
  insert: jest.Mock;
  values: jest.Mock;
}

const makeTx = (): MockTx => ({
  delete: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockResolvedValue(undefined),
});

interface StoredAcl {
  pageVisibility: string | null;
  pageProjectId: number | null;
  pageCreatedById: string | null;
}

const makeDb = (storedHash: string | null, tx?: MockTx, storedAcl?: StoredAcl) => {
  const txObj = tx ?? makeTx();
  const hashRows =
    storedHash === null
      ? []
      : [
          {
            contentHash: storedHash,
            pageVisibility: storedAcl?.pageVisibility ?? null,
            pageProjectId: storedAcl?.pageProjectId ?? null,
            pageCreatedById: storedAcl?.pageCreatedById ?? null,
          },
        ];

  return {
    db: {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(hashRows),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
      transaction: jest.fn().mockImplementation(async (fn: (t: MockTx) => unknown) => fn(txObj)),
      query: {
        kbArticles: { findFirst: jest.fn().mockResolvedValue(null) },
        kbPages: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    },
    tx: txObj,
  };
};

describe("KbIndexingService — content-hash guard", () => {
  it("does not call the embedder for archived, deleted, or unconfigured pages", async () => {
    for (const page of [
      { status: "archived", deletedAt: null },
      { status: "published", deletedAt: new Date() },
    ]) {
      const { db } = makeDb(null);
      (db.query.kbPages.findFirst as jest.Mock).mockResolvedValue({
        ...page,
        visibility: "private",
        contentText: "content that must not be embedded",
        projectId: null,
        createdById: "user-7",
      });
      const embeddings = makeEmbeddings();
      const svc = new KbIndexingService(db as never, embeddings as never, makeStorage() as never);

      await svc.indexPage("org-1", 99);

      expect(embeddings.embedQuery).not.toHaveBeenCalled();
    }

    const { db } = makeDb(null);
    (db.query.kbPages.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      visibility: "private",
      deletedAt: null,
      contentText: "content with embeddings disabled",
      projectId: null,
      createdById: "user-7",
    });
    const embeddings = makeEmbeddings(false);
    const svc = new KbIndexingService(db as never, embeddings as never, makeStorage() as never);

    await svc.indexPage("org-1", 99);

    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });

  it("skips re-embedding when the stored hash matches the current article text", async () => {
    const text = "Hello world content unchanged";
    const { db } = makeDb(sha256(text));
    (db.query.kbArticles.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      contentText: text,
    });

    const embeddings = makeEmbeddings();
    const svc = new KbIndexingService(db as never, embeddings as never, makeStorage() as never);
    await svc.indexArticle("org-1", 1);

    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });

  it("re-embeds when the stored hash differs from the current article text", async () => {
    const oldText = "old content";
    const newText = "new content that is different";

    const tx = makeTx();
    tx.delete = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
    tx.insert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });

    const { db } = makeDb(sha256(oldText), tx);
    (db.query.kbArticles.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      contentText: newText,
    });

    const embeddings = makeEmbeddings();
    const svc = new KbIndexingService(db as never, embeddings as never, makeStorage() as never);
    await svc.indexArticle("org-1", 1);

    expect(embeddings.embedQuery).toHaveBeenCalled();
  });

  it("re-embeds when no hash is stored yet (existing chunks predate the column)", async () => {
    const text = "content indexed before the hash column existed";

    const tx = makeTx();
    tx.delete = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
    tx.insert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });

    const { db } = makeDb(null, tx);
    (db.query.kbArticles.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      contentText: text,
    });

    const embeddings = makeEmbeddings();
    const svc = new KbIndexingService(db as never, embeddings as never, makeStorage() as never);
    await svc.indexArticle("org-1", 1);

    expect(embeddings.embedQuery).toHaveBeenCalled();
  });

  it("skips re-embedding for pages when content and ACL are both unchanged", async () => {
    const text = "page content that has not changed";
    const { db } = makeDb(sha256(text), undefined, {
      pageVisibility: "org",
      pageProjectId: null,
      pageCreatedById: null,
    });
    (db.query.kbPages.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      visibility: "org",
      deletedAt: null,
      contentText: text,
      projectId: null,
      createdById: null,
    });

    const embeddings = makeEmbeddings();
    const svc = new KbIndexingService(db as never, embeddings as never, makeStorage() as never);
    await svc.indexPage("org-1", 1);

    expect(embeddings.embedQuery).not.toHaveBeenCalled();
    expect(db.update as jest.Mock).not.toHaveBeenCalled();
  });

  it("updates chunk ACL without re-embedding when page moves to a different project", async () => {
    const text = "unchanged page body";
    const { db } = makeDb(sha256(text), undefined, {
      pageVisibility: "org",
      pageProjectId: 1,
      pageCreatedById: "user-7",
    });

    (db.query.kbPages.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      visibility: "org",
      deletedAt: null,
      contentText: text,
      projectId: 2,
      createdById: "user-7",
    });

    const embeddings = makeEmbeddings();
    const svc = new KbIndexingService(db as never, embeddings as never, makeStorage() as never);
    await svc.indexPage("org-1", 99);

    expect(embeddings.embedQuery).not.toHaveBeenCalled();
    expect(db.transaction as jest.Mock).not.toHaveBeenCalled();
    expect(db.update as jest.Mock).toHaveBeenCalled();
    const setMock = ((db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock }).set;
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ pageProjectId: 2, pageVisibility: "org", pageCreatedById: "user-7" }),
    );
  });
});

describe("KbIndexingService — a chunk carries the ACL it is filtered by", () => {
  const indexPageAt = async (projectId: number | null) => {
    const values = jest.fn().mockResolvedValue(undefined);
    const tx = makeTx();
    tx.delete = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
    tx.insert = jest.fn().mockReturnValue({ values });

    const { db } = makeDb(null, tx);
    (db.query.kbPages.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      visibility: "org",
      deletedAt: null,
      contentText: "a page with enough words to make one chunk",
      projectId,
      createdById: "user-7",
    });

    const svc = new KbIndexingService(db as never, makeEmbeddings() as never, makeStorage() as never);
    await svc.indexPage("org-1", 99);
    return values;
  };

  it("writes the page's visibility, project and author onto every chunk", async () => {
    const values = await indexPageAt(1);
    const rows = values.mock.calls[0]?.[0] as {
      pageVisibility: string;
      pageProjectId: number | null;
      pageCreatedById: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({
        pageVisibility: "org",
        pageProjectId: 1,
        pageCreatedById: "user-7",
      });
    }
  });

  it("moves the chunk with the page when the page changes project", async () => {
    const rowsBefore = (await indexPageAt(1)).mock.calls[0]?.[0] as { pageProjectId: number | null }[];
    const rowsAfter = (await indexPageAt(2)).mock.calls[0]?.[0] as { pageProjectId: number | null }[];

    expect(rowsBefore[0]?.pageProjectId).toBe(1);
    expect(rowsAfter[0]?.pageProjectId).toBe(2);
  });
});
