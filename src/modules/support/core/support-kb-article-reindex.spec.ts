import type { Db } from "../../../db/drizzle.module";
import { KbPageWriterService } from "../../kb/wiki/kb-page-writer.service";
import { updateArticle } from "./lib/support-kb-articles";

jest.mock("../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn().mockResolvedValue(undefined) },
}));

const ORG_ID = "org-reindex";
const ARTICLE_ID = 77;

function makeCurrent(status: string, contentRevision: number) {
  return {
    id: ARTICLE_ID,
    slug: "test-article",
    status,
    publishedAt: status === "published" ? new Date("2026-01-01") : null,
    title: "Test Article",
    contentText: "old body",
    visibility: "org",
    contentRevision,
  };
}

function makeUpdated(status: string, contentRevision: number, aclRevision: number) {
  return {
    id: ARTICLE_ID,
    orgId: ORG_ID,
    title: "Test Article",
    excerpt: null,
    status,
    visibility: "internal",
    contentRevision,
    aclRevision,
  };
}

function makeDb(current: unknown, updateResult: unknown[]) {
  const node: Record<string, unknown> = {};
  const self = (): unknown => node;
  node.from = self;
  node.innerJoin = self;
  node.where = self;
  node.orderBy = self;
  node.limit = (): Promise<unknown[]> => Promise.resolve([current]);
  node.then = (resolve: (rows: unknown[]) => unknown): Promise<unknown> =>
    Promise.resolve([current]).then(resolve);

  const selectResults: unknown[][] = [[current]];

  const returningFn = jest.fn().mockResolvedValue(updateResult);
  const whereFn = jest.fn().mockReturnValue({ returning: returningFn });
  const updateFn = jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: whereFn }) });

  const tx = {
    update: updateFn,
    select: jest.fn().mockImplementation(() => {
      const node2: Record<string, unknown> = {};
      const s = (): unknown => node2;
      node2.from = s;
      node2.innerJoin = s;
      node2.where = s;
      node2.orderBy = s;
      node2.limit = (): Promise<unknown[]> => Promise.resolve([]);
      node2.then = (resolve: (rows: unknown[]) => unknown): Promise<unknown> =>
        Promise.resolve([]).then(resolve);
      return node2;
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    }),
  };

  const db = {
    select: jest.fn().mockImplementation(() => {
      const chunk = selectResults.shift() ?? [];
      const n: Record<string, unknown> = {};
      const s = (): unknown => n;
      n.from = s;
      n.innerJoin = s;
      n.where = s;
      n.orderBy = s;
      n.limit = (): Promise<unknown[]> => Promise.resolve(chunk);
      n.then = (resolve: (rows: unknown[]) => unknown): Promise<unknown> =>
        Promise.resolve(chunk).then(resolve);
      return n;
    }),
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as Db;

  return db;
}

describe("updateArticle — reindex delegation to KbPageWriterService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("calls writer.commitPageChange when a published article's content changes, not OutboxWriter.emit directly", async () => {
    const writer = new KbPageWriterService({} as never);
    const commitSpy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);

    const db = makeDb(makeCurrent("published", 3), [makeUpdated("published", 4, 1)]);
    await updateArticle(db, writer, ORG_ID, ARTICLE_ID, { content: "new body" }, "user-1");

    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        page: expect.objectContaining({
          id: ARTICLE_ID,
          contentRevision: 4,
          aclRevision: 1,
        }),
      }),
    );
  });

  it("does not call writer.commitPageChange when the article is not published", async () => {
    const writer = new KbPageWriterService({} as never);
    const commitSpy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);

    const db = makeDb(makeCurrent("draft", 3), [makeUpdated("draft", 4, 1)]);
    await updateArticle(db, writer, ORG_ID, ARTICLE_ID, { content: "new body" }, "user-1");

    expect(commitSpy).not.toHaveBeenCalled();
  });

  it("does not call writer.commitPageChange for a metadata-only change on a published article", async () => {
    const writer = new KbPageWriterService({} as never);
    const commitSpy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);

    const db = makeDb(makeCurrent("published", 3), [makeUpdated("published", 3, 1)]);
    await updateArticle(db, writer, ORG_ID, ARTICLE_ID, { excerpt: "short summary" }, "user-1");

    expect(commitSpy).not.toHaveBeenCalled();
  });
});
