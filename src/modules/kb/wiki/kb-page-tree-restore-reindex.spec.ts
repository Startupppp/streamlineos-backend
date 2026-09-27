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
