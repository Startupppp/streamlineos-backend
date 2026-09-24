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
  title: "old title",
  content: { type: "doc", content: [{ type: "p", children: [{ text: "old title" }] }] },
  contentText: "old title",
  excerpt: null,
};

const RESULT_ROW = {
  id: 1,
  orgId: "org-1",
  spaceId: 1,
  categoryId: null,
  title: "old title",
  slug: "old-title",
  excerpt: null,
  content: VERSION_ROW.content,
  contentText: "old title",
  status: "published" as const,
  visibility: "org" as const,
  createdById: "user-1",
  ownerMembershipId: 1,
  trustState: "unverified" as const,
  verifiedUntil: null,
  views: 0,
  helpfulCount: 0,
  notHelpfulCount: 0,
  seoTitle: null,
  seoDescription: null,
  reviewIntervalDays: null,
  publishedAt: null,
  archivedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  aclRevision: 1,
  contentRevision: 2,
};

function thenable(rows: unknown[]): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  const self = (): unknown => node;
  node.from = self;
  node.where = self;
  node.limit = self;
  node.then = (resolve: (value: unknown[]) => unknown): Promise<unknown> =>
    Promise.resolve(rows).then(resolve);
  return node;
}

function makeDb() {
  const returning = jest.fn().mockResolvedValue([RESULT_ROW]);
  const where = jest.fn().mockReturnValue({ returning });
  const setFn = jest.fn().mockReturnValue({ where });
  const txUpdate = jest.fn().mockReturnValue({ set: setFn });

  const selectResults: unknown[][] = [[VERSION_ROW], [{ max: 0 }]];
  const txSelect = jest.fn().mockImplementation(() => thenable(selectResults.shift() ?? []));

  const insertValues = jest.fn().mockResolvedValue([]);
  const txInsert = jest.fn().mockReturnValue({ values: insertValues });

  const tx = { update: txUpdate, select: txSelect, insert: txInsert };

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

  it("restores the version's own contentText rather than re-deriving it from the document", async () => {
    const { db, setFn } = makeDb();
    jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);

    const access = { assertArticleEditable: jest.fn().mockResolvedValue(undefined) };
    const svc = new KbArticlesService(db as never, access as never, {} as never);

    await svc.restoreVersion(makeUser(), 1, 1);

    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({ contentText: "old title", content: VERSION_ROW.content }),
    );
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
