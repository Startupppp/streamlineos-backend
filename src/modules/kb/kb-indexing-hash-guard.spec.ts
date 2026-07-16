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

const makeArticle = (text: string) => ({
  status: "published" as const,
  contentText: text,
});

const makeDb = (existingChunks: { content: string }[] = []) => {
  const tx = {
    delete: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockResolvedValue(undefined),
  };

  const dbObj: Record<string, jest.Mock | unknown> = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(existingChunks),
    orderBy: jest.fn().mockReturnThis(),
    transaction: jest.fn().mockImplementation(async (fn: (tx: typeof tx) => unknown) => fn(tx)),
    query: {
      kbArticles: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
  };

  dbObj.select = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockResolvedValue(existingChunks),
      }),
    }),
  });

  return { db: dbObj, tx };
};

describe("KbIndexingService — content-hash guard", () => {
  it("skips re-embedding when content is unchanged", async () => {
    const text = "Hello world content unchanged";
    const chunks = [{ content: text }];

    const { db } = makeDb(chunks);
    (db.query as Record<string, unknown>).kbArticles = {
      findFirst: jest.fn().mockResolvedValue(makeArticle(text)),
    };

    const embeddings = makeEmbeddings();
    const storage = makeStorage();

    const svc = new KbIndexingService(db as never, embeddings as never, storage as never);
    await svc.indexArticle("org-1", 1);

    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });

  it("re-embeds when content has changed", async () => {
    const oldText = "old content";
    const newText = "new content that is different";

    const chunks = [{ content: oldText }];

    const { db, tx } = makeDb(chunks);
    (db.query as Record<string, unknown>).kbArticles = {
      findFirst: jest.fn().mockResolvedValue(makeArticle(newText)),
    };

    tx.delete = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
    tx.insert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });

    const embeddings = makeEmbeddings();
    const storage = makeStorage();

    const svc = new KbIndexingService(db as never, embeddings as never, storage as never);
    await svc.indexArticle("org-1", 1);

    expect(embeddings.embedQuery).toHaveBeenCalled();
  });

  it("skips re-embedding for pages when content is unchanged", async () => {
    const text = "page content that has not changed";
    const chunks = [{ content: text }];

    const { db } = makeDb(chunks);
    (db.query as Record<string, unknown>).kbPages = {
      findFirst: jest.fn().mockResolvedValue({
        status: "published",
        visibility: "org",
        deletedAt: null,
        contentText: text,
      }),
    };

    const embeddings = makeEmbeddings();
    const storage = makeStorage();

    const svc = new KbIndexingService(db as never, embeddings as never, storage as never);
    await svc.indexPage("org-1", 1);

    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });
});
