import type { Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { KbArticlesService } from "./kb-articles.service";

/**
 * Every KB article write that can change what retrieval should be serving has
 * to emit a `kb.content.index` outbox event on the SAME transaction as the
 * row it describes — otherwise search keeps answering from the old content
 * and nothing reports it.
 *
 * Written 2026-09-11 alongside the split that moved that emit into
 * `lib/kb-article-write.ts`. Before this file existed the emit was copied
 * into five methods and NOTHING covered it: stubbing the emit to a no-op left
 * all 72 kb suites green. The mutation that now fails is exactly that —
 * `return;` as the first statement of `emitArticleIndexEvent`.
 */
describe("KbArticlesService — kb.content.index outbox event", () => {
  const ORG = "org-1";
  const ARTICLE_ID = 77;

  const PAGE_ROW = {
    id: ARTICLE_ID,
    orgId: ORG,
    spaceId: 1,
    categoryId: null,
    title: "Doc",
    slug: "doc",
    excerpt: null,
    content: { type: "doc", content: [] },
    contentText: "",
    status: "published",
    visibility: "org",
    createdById: "user-1",
    ownerMembershipId: 9,
    trustState: "unverified",
    verifiedUntil: null,
    views: 0,
    helpfulCount: 0,
    notHelpfulCount: 0,
    seoTitle: null,
    seoDescription: null,
    reviewIntervalDays: null,
    publishedAt: new Date(),
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    aclRevision: 2,
    contentRevision: 4,
  };

  const VERSION_ROW = { title: "Doc", content: { type: "doc", content: [] }, contentText: "", excerpt: null };

  const user = {
    orgId: ORG,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 9, isOrgOwner: false },
  } as never;
  const access = { assertArticleEditable: jest.fn().mockResolvedValue(undefined) } as never;
  const events = { record: jest.fn().mockResolvedValue(undefined) } as never;

  let emit: jest.SpyInstance;

  function thenable(rows: unknown[]): Record<string, unknown> {
    const node: Record<string, unknown> = {};
    const self = (): unknown => node;
    node.from = self;
    node.innerJoin = self;
    node.where = self;
    node.orderBy = self;
    node.limit = self;
    node.then = (resolve: (value: unknown[]) => unknown): Promise<unknown> =>
      Promise.resolve(rows).then(resolve);
    return node;
  }

  function makeDb(selectResults: unknown[][], returnedRow: unknown = PAGE_ROW) {
    const queue = [...selectResults];
    const tx = {
      select: jest.fn().mockImplementation(() => thenable(queue.shift() ?? [])),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([returnedRow]),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    };
    const db = {
      transaction: jest.fn().mockImplementation((cb: (t: unknown) => unknown) => cb(tx)),
    } as unknown as Db;
    return { db, tx };
  }

  beforeEach(() => {
    emit = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
  });

  afterEach(() => {
    emit.mockRestore();
  });

  it("archive emits the reindex event on the write transaction", async () => {
    const { db, tx } = makeDb([]);
    await new KbArticlesService(db, access, events).archive(user, ARTICLE_ID);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toBe(tx);
  });

  it("unpublish emits the reindex event", async () => {
    const { db } = makeDb([]);
    await new KbArticlesService(db, access, events).unpublish(user, ARTICLE_ID);

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("publish emits the reindex event", async () => {
    const { db } = makeDb([[{ publishedAt: null }], [{ max: 3 }]]);
    await new KbArticlesService(db, access, events).publish(user, ARTICLE_ID);

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("carries the article's own revision counters, not placeholders", async () => {
    const { db } = makeDb([]);
    await new KbArticlesService(db, access, events).archive(user, ARTICLE_ID);

    const input = emit.mock.calls[0][1] as {
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      organizationId: string;
      payload: Record<string, unknown>;
    };
    expect(input.eventType).toBe("kb.content.index");
    expect(input.aggregateType).toBe("kb_article");
    expect(input.aggregateId).toBe(String(ARTICLE_ID));
    expect(input.organizationId).toBe(ORG);
    expect(input.payload).toMatchObject({
      contentType: "article",
      contentId: ARTICLE_ID,
      contentRevision: PAGE_ROW.contentRevision,
      aclRevision: PAGE_ROW.aclRevision,
    });
  });

  it("restoreVersion emits only when the restored article is published", async () => {
    const published = makeDb([[VERSION_ROW], [{ max: 3 }]]);
    await new KbArticlesService(published.db, access, events).restoreVersion(user, ARTICLE_ID, 2);
    expect(emit).toHaveBeenCalledTimes(1);

    emit.mockClear();
    const draft = makeDb([[VERSION_ROW], [{ max: 3 }]], { ...PAGE_ROW, status: "draft" });
    await new KbArticlesService(draft.db, access, events).restoreVersion(user, ARTICLE_ID, 2);
    expect(emit).not.toHaveBeenCalled();
  });
});
