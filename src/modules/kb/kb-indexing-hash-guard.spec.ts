import { KbIndexingService } from "./kb-indexing.service";
import { EmbeddingsService } from "../ai/providers/embeddings.service";
import { StorageService } from "../storage/storage.service";

const EMBEDDING_DIM = 1536;

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

const makeDb = (existingChunks: { content: string }[] = [], tx?: MockTx) => {
  const txObj = tx ?? makeTx();

  return {
    db: {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue(existingChunks),
          }),
        }),
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
  it("skips re-embedding when article content is unchanged", async () => {
    const text = "Hello world content unchanged";
    const { db } = makeDb([{ content: text }]);
    (db.query.kbArticles.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      contentText: text,
    });

    const embeddings = makeEmbeddings();
    const svc = new KbIndexingService(db as never, embeddings as never, makeStorage() as never);
    await svc.indexArticle("org-1", 1);

    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });

  it("re-embeds when article content has changed", async () => {
    const oldText = "old content";
    const newText = "new content that is different";

    const tx = makeTx();
    tx.delete = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
    tx.insert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });

    const { db } = makeDb([{ content: oldText }], tx);
    (db.query.kbArticles.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      contentText: newText,
    });

    const embeddings = makeEmbeddings();
    const svc = new KbIndexingService(db as never, embeddings as never, makeStorage() as never);
    await svc.indexArticle("org-1", 1);

    expect(embeddings.embedQuery).toHaveBeenCalled();
  });

  it("skips re-embedding for pages when content is unchanged", async () => {
    const text = "page content that has not changed";
    const { db } = makeDb([{ content: text }]);
    (db.query.kbPages.findFirst as jest.Mock).mockResolvedValue({
      status: "published",
      visibility: "org",
      deletedAt: null,
      contentText: text,
    });

    const embeddings = makeEmbeddings();
    const svc = new KbIndexingService(db as never, embeddings as never, makeStorage() as never);
    await svc.indexPage("org-1", 1);

    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });
});
