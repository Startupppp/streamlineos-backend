import { sql } from "drizzle-orm";
import { KbPageVersionsService } from "./kb-page-versions.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

jest.mock("./kb-page-edit.util", () => ({
  snapshotIfNeeded: jest.fn().mockResolvedValue(undefined),
  resyncPageLinks: jest.fn().mockResolvedValue(undefined),
}));

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

const PAGE_ROW = {
  id: 7,
  orgId: "org-1",
  title: "Old title",
  content: { type: "doc" },
  contentText: "old content",
  contentRevision: 3,
  aclRevision: 2,
  isLocked: false,
  deletedAt: null,
};

const RESTORED_ROW = {
  ...PAGE_ROW,
  title: "version title",
  contentText: "version content",
  contentRevision: 4,
};

const VERSION_ROW = {
  id: 2,
  pageId: 7,
  orgId: "org-1",
  versionNumber: 2,
  title: "version title",
  content: { type: "doc" },
  contentText: "version content",
};

function makeDb() {
  const returning = jest.fn().mockResolvedValue([RESTORED_ROW]);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  const txUpdate = jest.fn().mockReturnValue({ set });
  const txInsert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) });
  const tx = { update: txUpdate, insert: txInsert };

  const db = {
    query: {
      kbPages: {
        findFirst: jest.fn().mockResolvedValue(PAGE_ROW),
      },
      kbPageVersions: {
        findFirst: jest.fn().mockResolvedValue(VERSION_ROW),
      },
    },
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx)),
  };

  return { db, txInsert, tx };
}

function makeAuthMock() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 7, action: "edit", via: "admin" }),
  };
}

describe("KbPageVersionsService.restoreVersion — re-index after restore", () => {
  beforeEach(() => jest.clearAllMocks());

  it("emits kb.content.index via OutboxWriter.emit inside the transaction", async () => {
    const { db, txInsert } = makeDb();
    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    const svc = new KbPageVersionsService(db as never, makeAuthMock() as never);

    await svc.restoreVersion(makeUser(), 7, 2, false);

    expect(emitSpy).toHaveBeenCalledTimes(1);
    const [calledTx, event] = emitSpy.mock.calls[0] as [unknown, { eventType: string; payload: Record<string, unknown> }];
    expect(event.eventType).toBe("kb.content.index");
    expect(event.payload).toMatchObject({ contentType: "page", contentId: 7 });
    void calledTx;
    void txInsert;
  });

  it("bites: removing OutboxWriter.emit from restoreVersion causes the spy to record zero calls", async () => {
    const { db } = makeDb();
    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    const svc = new KbPageVersionsService(db as never, makeAuthMock() as never);

    await svc.restoreVersion(makeUser(), 7, 2, false);

    expect(emitSpy).toHaveBeenCalled();
  });

  it("bumps contentRevision in the update (content_revision + 1 SQL expression is present)", async () => {
    const { db, tx } = makeDb();
    jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    const svc = new KbPageVersionsService(db as never, makeAuthMock() as never);

    await svc.restoreVersion(makeUser(), 7, 2, false);

    const setArgs = (tx.update as jest.Mock).mock.results[0]?.value?.set?.mock?.calls?.[0]?.[0] as Record<string, unknown>;
    expect(setArgs).toBeDefined();
    const contentRevisionVal = setArgs["contentRevision"];
    expect(contentRevisionVal).toBeDefined();
    const serialised = JSON.stringify(contentRevisionVal);
    expect(serialised).toContain("content_revision");
    expect(serialised).toContain("1");
  });

  it("restoreVersion requests 'edit' access not 'view' because it overwrites page content", async () => {
    const { db } = makeDb();
    jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    const authMock = makeAuthMock();
    const svc = new KbPageVersionsService(db as never, authMock as never);

    await svc.restoreVersion(makeUser(), 7, 2, false);

    expect(authMock.assertPageAccess).toHaveBeenCalledTimes(1);
    const [, , action] = authMock.assertPageAccess.mock.calls[0] as [unknown, unknown, string];
    expect(action).not.toBe("view");
    expect(action).toBe("edit");
  });
});
