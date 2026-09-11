import { KbArticlesService } from "./kb-articles.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    principal: humanSessionPrincipal(1, false),
  } as unknown as CurrentUserContext;
}

const VERSION_ROW = {
  id: 2,
  articleId: 1,
  orgId: "org-1",
  versionNumber: 1,
  title: "old title",
  content: "{}",
  excerpt: null,
};

const RESULT_ROW = {
  id: 1,
  orgId: "org-1",
  title: "old title",
  content: "{}",
  excerpt: null,
  status: "published" as const,
  contentRevision: 2,
  aclRevision: 1,
};

function makeDb() {
  const returning = jest.fn().mockResolvedValue([RESULT_ROW]);
  const where = jest.fn().mockReturnValue({ returning });
  const setFn = jest.fn().mockReturnValue({ where });
  const txUpdate = jest.fn().mockReturnValue({ set: setFn });

  const selectWhere = jest.fn().mockResolvedValue([{ max: 0 }]);
  const selectFrom = jest.fn().mockReturnValue({ where: selectWhere });
  const txSelect = jest.fn().mockReturnValue({ from: selectFrom });

  const insertValues = jest.fn().mockResolvedValue([]);
  const txInsert = jest.fn().mockReturnValue({ values: insertValues });

  const tx = {
    update: txUpdate,
    select: txSelect,
    insert: txInsert,
    query: {
      kbArticleVersions: {
        findFirst: jest.fn().mockResolvedValue(VERSION_ROW),
      },
    },
  };

  const db = {
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };

  return { db, tx, setFn };
}

describe("KbArticlesService.restoreVersion — contentRevision bump", () => {
  beforeEach(() => jest.clearAllMocks());

  it("includes contentRevision sql expression in the update set so the search index is not skipped", async () => {
    const { db, setFn } = makeDb();
    jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);

    const access = { assertArticleEditable: jest.fn().mockResolvedValue(undefined) };
    const events = {};
    const svc = new KbArticlesService(db as never, access as never, events as never);

    await svc.restoreVersion(makeUser(), 1, 1);

    expect(setFn).toHaveBeenCalledTimes(1);
    const setArg = setFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).toBeDefined();
    expect(setArg).toHaveProperty("contentRevision");

    const serialised = JSON.stringify(setArg["contentRevision"]);
    expect(serialised).toContain("content_revision");
    expect(serialised).toContain("1");
  });

  it("emits a reindex event carrying the updated contentRevision", async () => {
    const { db } = makeDb();
    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);

    const access = { assertArticleEditable: jest.fn().mockResolvedValue(undefined) };
    const events = {};
    const svc = new KbArticlesService(db as never, access as never, events as never);

    await svc.restoreVersion(makeUser(), 1, 1);

    expect(emitSpy).toHaveBeenCalledTimes(1);
    const [, event] = emitSpy.mock.calls[0] as [unknown, { eventType: string; payload: Record<string, unknown> }];
    expect(event.eventType).toBe("kb.content.index");
    expect(event.payload).toMatchObject({ contentType: "article", contentId: 1 });
  });
});
