import { sql } from "drizzle-orm";
import { KbPageTreeService } from "./kb-page-tree.service";
import { KbPageWriterService } from "./kb-page-writer.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  } as CurrentUserContext;
}

const DELETED_PAGE = {
  id: 10,
  orgId: "org-1",
  title: "Deleted Page",
  parentPageId: null,
  deletedAt: new Date("2026-01-01"),
};

const RESTORED_PAGE = {
  id: 10,
  orgId: "org-1",
  title: "Deleted Page",
  parentPageId: null,
  deletedAt: null,
  contentRevision: 2,
  aclRevision: 1,
  contentText: "some content here",
};

function makeDb(subtreeIds: number[], pagesToIndexRows: typeof RESTORED_PAGE[]) {
  const txInsert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) });
  const txUpdateWhere = jest.fn().mockResolvedValue([]);
  const txUpdateSet = jest.fn().mockReturnValue({ where: txUpdateWhere });
  const txUpdate = jest.fn().mockReturnValue({ set: txUpdateSet });

  const txSelectFromWhere = jest.fn()
    .mockResolvedValueOnce(pagesToIndexRows)
    .mockResolvedValueOnce([RESTORED_PAGE]);
  const txSelectFrom = jest.fn().mockReturnValue({ where: txSelectFromWhere });
  const txSelect = jest.fn().mockReturnValue({ from: txSelectFrom });

  const txExecute = jest.fn().mockResolvedValue(subtreeIds.map((id) => ({ id })));
  const tx = {
    execute: txExecute,
    update: txUpdate,
    insert: txInsert,
    select: txSelect,
    query: {
      kbPages: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
  };

  const db = {
    query: {
      kbPages: {
        findFirst: jest.fn().mockResolvedValue(DELETED_PAGE),
      },
    },
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx)),
  };

  return { db, txInsert, tx };
}

const makeAudit = () => ({ log: jest.fn(), logCritical: jest.fn().mockResolvedValue(undefined) });
const makeAuth = () => ({
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "edit", via: "admin" }),
});

describe("KbPageTreeService.restore — emits kb.content.index for restored pages", () => {
  beforeEach(() => jest.clearAllMocks());

  it("emits one kb.content.index event per restored page that has content", async () => {
    const emitSpy = jest.spyOn(OutboxWriter, "emitMany").mockResolvedValue(undefined);
    const { db } = makeDb([10], [RESTORED_PAGE]);
    const svc = new KbPageTreeService(
      db as never,
      makeAudit() as never,
      makeAuth() as never,
      {} as never,
      new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined) } as never),
    );

    await svc.restore(makeUser(), 10);

    expect(emitSpy).toHaveBeenCalledTimes(1);
    const events = emitSpy.mock.calls[0]?.[1] ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("kb.content.index");
    expect(events[0]?.payload).toMatchObject({ contentType: "page", contentId: 10 });
  });

  it("does not emit for pages with no content text", async () => {
    const emitSpy = jest.spyOn(OutboxWriter, "emitMany").mockResolvedValue(undefined);
    const emptyPage = { ...RESTORED_PAGE, contentText: "" };
    const { db } = makeDb([10], [emptyPage]);
    const svc = new KbPageTreeService(
      db as never,
      makeAudit() as never,
      makeAuth() as never,
      {} as never,
      new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined) } as never),
    );

    await svc.restore(makeUser(), 10);

    const events = emitSpy.mock.calls[0]?.[1] ?? [];
    expect(events).toEqual([]);
  });

  it("emits events for each page in a multi-page subtree", async () => {
    const emitSpy = jest.spyOn(OutboxWriter, "emitMany").mockResolvedValue(undefined);
    const child = { ...RESTORED_PAGE, id: 11, contentText: "child content" };
    const { db } = makeDb([10, 11], [RESTORED_PAGE, child]);
    const svc = new KbPageTreeService(
      db as never,
      makeAudit() as never,
      makeAuth() as never,
      {} as never,
      new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined) } as never),
    );

    await svc.restore(makeUser(), 10);

    expect(emitSpy).toHaveBeenCalledTimes(1);
    const events = emitSpy.mock.calls[0]?.[1] ?? [];
    const ids = events.map((event) => Number(event.payload["contentId"]));
    expect(ids).toContain(10);
    expect(ids).toContain(11);
  });

  it("bites: removing OutboxWriter.emitMany from restore leaves the spy uncalled", async () => {
    const emitSpy = jest.spyOn(OutboxWriter, "emitMany").mockResolvedValue(undefined);
    const { db } = makeDb([10], [RESTORED_PAGE]);
    const svc = new KbPageTreeService(
      db as never,
      makeAudit() as never,
      makeAuth() as never,
      {} as never,
      new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined) } as never),
    );

    await svc.restore(makeUser(), 10);

    expect(emitSpy).toHaveBeenCalled();
    const events = emitSpy.mock.calls[0]?.[1] ?? [];
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("KbPageTreeService.restoreMany — one transaction for a whole bulk restore", () => {
  const deleted = new Date("2026-01-01");

  function makeBatchDb(
    pages: Array<{ id: number; parentPageId: number | null; deletedAt: Date | null; title: string }>,
    subtreeIds: number[],
  ) {
    const updateSets: unknown[] = [];
    const tx = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn()
            .mockResolvedValueOnce(pages)
            .mockResolvedValueOnce(pages)
            .mockResolvedValueOnce([]),
        }),
      }),
      execute: jest.fn().mockResolvedValue(subtreeIds.map((id) => ({ id }))),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((values: unknown) => {
          updateSets.push(values);
          return { where: jest.fn().mockResolvedValue([]) };
        }),
      }),
    };
    const db = {
      transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)),
    };
    const audit = { logCriticalMany: jest.fn().mockResolvedValue(undefined) };
    const writer = { commitManyPageChanges: jest.fn().mockResolvedValue(undefined) };
    const svc = new KbPageTreeService(
      db as never,
      audit as never,
      makeAuth() as never,
      {} as never,
      writer as never,
    );
    return { svc, db, tx, audit, updateSets };
  }

  const parent = { id: 10, parentPageId: null, deletedAt: deleted, title: "Parent" };
  const child = { id: 11, parentPageId: 10, deletedAt: deleted, title: "Child" };

  it("restores parent and child in one transaction; a child listed after its parent is covered, not re-restored", async () => {
    const { svc, db, audit, updateSets } = makeBatchDb([parent, child], [10, 11]);

    await svc.restoreMany(makeUser(), [10, 11]);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(updateSets).toEqual([{ deletedAt: null, deletedById: null }]);
    const entries = audit.logCriticalMany.mock.calls[0]?.[0] ?? [];
    expect(entries.map((e: { resourceId: string }) => e.resourceId)).toEqual(["10"]);
  });

  it("a child listed before its deleted parent is detached to the root, as the per-page loop did", async () => {
    const { svc, audit, updateSets } = makeBatchDb([parent, child], [11, 10]);

    await svc.restoreMany(makeUser(), [11, 10]);

    expect(updateSets).toEqual([{ deletedAt: null, deletedById: null }, { parentPageId: null }]);
    const entries = audit.logCriticalMany.mock.calls[0]?.[0] ?? [];
    expect(entries.map((e: { resourceId: string }) => e.resourceId)).toEqual(["11", "10"]);
  });

  it("a page restored concurrently is skipped: no subtree walk, no update, no audit", async () => {
    const { svc, tx, audit } = makeBatchDb([{ id: 7, parentPageId: null, deletedAt: null, title: "Live" }], []);

    await svc.restoreMany(makeUser(), [7]);

    expect(tx.execute).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(audit.logCriticalMany).not.toHaveBeenCalled();
  });
});
