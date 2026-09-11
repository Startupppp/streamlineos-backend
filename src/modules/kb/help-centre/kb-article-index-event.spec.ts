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

  const ARTICLE_ROW = {
    id: ARTICLE_ID,
    orgId: ORG,
    title: "Doc",
    content: "{}",
    excerpt: null,
    status: "published",
    publishedAt: new Date(),
    contentRevision: 4,
    aclRevision: 2,
  };

  const user = {
    orgId: ORG,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 9, isOrgOwner: false },
  } as never;
  const access = { assertArticleEditable: jest.fn().mockResolvedValue(undefined) } as never;
  const events = { record: jest.fn().mockResolvedValue(undefined) } as never;

  let emit: jest.SpyInstance;

  function makeDb() {
    const tx = {
      query: {
        kbArticles: { findFirst: jest.fn().mockResolvedValue({ publishedAt: null }) },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([ARTICLE_ROW]),
          }),
        }),
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ max: 3 }]),
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
    const { db, tx } = makeDb();
    await new KbArticlesService(db, access, events).archive(user, ARTICLE_ID);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toBe(tx);
  });

  it("unpublish emits the reindex event", async () => {
    const { db } = makeDb();
    await new KbArticlesService(db, access, events).unpublish(user, ARTICLE_ID);

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("publish emits the reindex event", async () => {
    const { db } = makeDb();
    await new KbArticlesService(db, access, events).publish(user, ARTICLE_ID);

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("carries the article's own revision counters, not placeholders", async () => {
    const { db } = makeDb();
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
      contentRevision: ARTICLE_ROW.contentRevision,
      aclRevision: ARTICLE_ROW.aclRevision,
    });
  });

  it("restoreVersion emits only when the restored article is published", async () => {
    const { db, tx } = makeDb();
    tx.query.kbArticles.findFirst.mockResolvedValue({ publishedAt: null });
    const txWithVersion = tx as unknown as {
      query: { kbArticleVersions?: { findFirst: jest.Mock } };
    };
    txWithVersion.query.kbArticleVersions = {
      findFirst: jest.fn().mockResolvedValue({ title: "Doc", content: "{}", excerpt: null }),
    };

    await new KbArticlesService(db, access, events).restoreVersion(user, ARTICLE_ID, 2);
    expect(emit).toHaveBeenCalledTimes(1);

    emit.mockClear();
    const draft = makeDb();
    (draft.tx as unknown as { query: Record<string, unknown> }).query.kbArticleVersions = {
      findFirst: jest.fn().mockResolvedValue({ title: "Doc", content: "{}", excerpt: null }),
    };
    draft.tx.update.mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ ...ARTICLE_ROW, status: "draft" }]),
        }),
      }),
    });
    await new KbArticlesService(draft.db, access, events).restoreVersion(user, ARTICLE_ID, 2);
    expect(emit).not.toHaveBeenCalled();
  });
});
