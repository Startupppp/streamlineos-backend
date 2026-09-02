import { createHash } from "node:crypto";
import { KbIndexingService } from "./kb-indexing.service";

const EMBEDDING_DIM = 1536;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const makeEmbeddings = () => ({
  isEmbeddingConfigured: jest.fn().mockReturnValue(true),
  embedBatchWithCredit: jest.fn().mockImplementation(({ texts }: { texts: string[] }) =>
    Promise.resolve({
      ok: true,
      vectors: texts.map(() => new Array(EMBEDDING_DIM).fill(0.1) as number[]),
    }),
  ),
});

const makeCheckpoint = () => ({
  loadCheckpoints: jest.fn().mockResolvedValue(new Map()),
  saveCheckpoints: jest.fn().mockResolvedValue(undefined),
  clearCheckpoints: jest.fn().mockResolvedValue(undefined),
});

interface StoredChunk {
  contentHash: string;
  aclRevision: number;
  contentRevision: number;
}

/**
 * `db.transaction` must invoke its callback — a bare jest.fn() would silently
 * void every assertion about the write inside it.
 */
function makeDb(stored: StoredChunk | null) {
  const setSpy = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
  const update = jest.fn().mockReturnValue({ set: setSpy });
  const insertValues = jest.fn().mockResolvedValue(undefined);
  const tx = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(stored === null ? [] : [stored]),
        }),
      }),
    }),
    update,
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    insert: jest.fn().mockReturnValue({ values: insertValues }),
    execute: jest.fn().mockResolvedValue([]),
    query: {
      kbArticles: { findFirst: jest.fn() },
      kbPages: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  };
  const db = {
    select: tx.select,
    update,
    delete: tx.delete,
    insert: tx.insert,
    query: tx.query,
    transaction: jest.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { db, tx, update, setSpy, insertValues };
}

const TEXT = "an article whose body did not change";

describe("KbIndexingService.indexArticle — an ACL move with unchanged text", () => {
  it("updates the chunk ACL in place and never re-embeds", async () => {
    const { db, update, setSpy, insertValues } = makeDb({
      contentHash: sha256(TEXT),
      aclRevision: 3,
      contentRevision: 9,
    });
    (db.query.kbArticles.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      contentText: TEXT,
      aclRevision: 4,
      contentRevision: 9,
    });

    const embeddings = makeEmbeddings();
    const svc = new KbIndexingService(db as never, embeddings as never, makeCheckpoint() as never);
    await svc.indexArticle("org-1", 1);

    expect(embeddings.embedBatchWithCredit).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith({ aclRevision: 4, contentRevision: 9 });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("BITE — without the branch the chunks keep the stale revision, which the candidate gate joins with = and so drops the article from retrieval entirely", async () => {
    const { db, setSpy } = makeDb({
      contentHash: sha256(TEXT),
      aclRevision: 3,
      contentRevision: 9,
    });
    (db.query.kbArticles.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      contentText: TEXT,
      aclRevision: 4,
      contentRevision: 9,
    });

    const svc = new KbIndexingService(db as never, makeEmbeddings() as never, makeCheckpoint() as never);
    await svc.indexArticle("org-1", 1);

    const [written] = setSpy.mock.calls[0] as [{ aclRevision: number }];
    expect(written.aclRevision).toBe(4);
    expect(written.aclRevision).not.toBe(3);
  });

  it("a content revision that moved on its own is carried too", async () => {
    const { db, setSpy } = makeDb({
      contentHash: sha256(TEXT),
      aclRevision: 3,
      contentRevision: 9,
    });
    (db.query.kbArticles.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      contentText: TEXT,
      aclRevision: 3,
      contentRevision: 10,
    });

    const svc = new KbIndexingService(db as never, makeEmbeddings() as never, makeCheckpoint() as never);
    await svc.indexArticle("org-1", 1);

    expect(setSpy).toHaveBeenCalledWith({ aclRevision: 3, contentRevision: 10 });
  });

  it("writes nothing at all when neither the text nor the revisions moved", async () => {
    const { db, update, insertValues } = makeDb({
      contentHash: sha256(TEXT),
      aclRevision: 3,
      contentRevision: 9,
    });
    (db.query.kbArticles.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      contentText: TEXT,
      aclRevision: 3,
      contentRevision: 9,
    });

    const embeddings = makeEmbeddings();
    const svc = new KbIndexingService(db as never, embeddings as never, makeCheckpoint() as never);
    await svc.indexArticle("org-1", 1);

    expect(embeddings.embedBatchWithCredit).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("changed text still takes the full re-embed path, not the ACL shortcut", async () => {
    const { db, update, insertValues } = makeDb({
      contentHash: sha256("the previous body"),
      aclRevision: 3,
      contentRevision: 9,
    });
    (db.query.kbArticles.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      contentText: TEXT,
      aclRevision: 4,
      contentRevision: 10,
    });

    const embeddings = makeEmbeddings();
    const svc = new KbIndexingService(db as never, embeddings as never, makeCheckpoint() as never);
    await svc.indexArticle("org-1", 1);

    expect(embeddings.embedBatchWithCredit).toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
