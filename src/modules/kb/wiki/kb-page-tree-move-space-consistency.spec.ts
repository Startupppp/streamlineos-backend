import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { outboxEvents } from "../../../db/schema/common/outbox";
import { KbPageTreeService } from "./kb-page-tree.service";
import { KbPageWriterService } from "./kb-page-writer.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeUser(orgId: string) {
  return { orgId, userId: "user-1", isOrgOwner: false } as never;
}

const audit = {} as never;

function makeAuth() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(undefined),
    assertPageAccess: jest.fn().mockResolvedValue({
      orgId: "o1",
      pageId: 1,
      action: "edit",
      via: "admin",
    }),
    assertSpaceAccess: jest.fn().mockResolvedValue({ orgId: "o1", spaceId: 1, action: "edit", via: "space" }),
  };
}

function makeMoveDb(pageRow: { id: number; parentPageId: number | null; spaceId: number | null }, targetParentRow: { spaceId: number | null } | undefined) {
  const findFirst = jest
    .fn()
    .mockResolvedValueOnce(pageRow)
    .mockResolvedValueOnce(targetParentRow);
  const updateWhere = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([{ id: pageRow.id, parentPageId: null, sortOrder: 100, spaceId: targetParentRow?.spaceId ?? pageRow.spaceId, contentRevision: 7, aclRevision: 11 }]),
  });
  const txUpdate = jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) });
  const txSelect = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) }) }),
  });
  const txValues = jest.fn().mockResolvedValue([]);
  const txInsert = jest.fn().mockReturnValue({ values: txValues });
  const transaction = jest
    .fn()
    .mockImplementation(async (fn: (t: unknown) => unknown) => fn({ update: txUpdate, select: txSelect, insert: txInsert }));
  const db = {
    query: { kbPages: { findFirst } },
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    transaction,
  } as unknown as Db;
  return { db, transaction, txUpdate, updateWhere, txInsert, txValues };
}

describe("KbPageTreeService.move — space consistency between source and target", () => {
  it("BITE: adopts the target parent's space and authorizes it when it differs from the page's own space", async () => {
    const PAGE_ID = 60;
    const TARGET_ID = 61;
    const { db, updateWhere } = makeMoveDb(
      { id: PAGE_ID, parentPageId: null, spaceId: 1 },
      { spaceId: 2 },
    );
    const auth = makeAuth();
    const svc = new KbPageTreeService(db, audit, auth as never, {} as never, new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never));

    await svc.move(makeUser("org-space-move"), PAGE_ID, {
      parentPageId: TARGET_ID,
      index: 0,
    });

    expect(auth.assertSpaceAccess).toHaveBeenCalledWith(expect.anything(), 2, "edit");
    expect(updateWhere).toHaveBeenCalled();
    const setCall = (db.transaction as jest.Mock).mock.calls.length;
    expect(setCall).toBeGreaterThan(0);
  });

  it("refuses the move when the actor cannot access the target parent's space, and writes nothing", async () => {
    const PAGE_ID = 62;
    const TARGET_ID = 63;
    const { db, transaction, txUpdate } = makeMoveDb(
      { id: PAGE_ID, parentPageId: null, spaceId: 1 },
      { spaceId: 2 },
    );
    const auth = makeAuth();
    auth.assertSpaceAccess.mockRejectedValue(new NotFoundException("Space not found"));
    const svc = new KbPageTreeService(db, audit, auth as never, {} as never, new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never));

    await expect(
      svc.move(makeUser("org-space-move-denied"), PAGE_ID, {
        parentPageId: TARGET_ID,
        index: 0,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(transaction).not.toHaveBeenCalled();
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("positive control: does not check space access when the target parent is in the same space", async () => {
    const PAGE_ID = 64;
    const TARGET_ID = 65;
    const { db } = makeMoveDb(
      { id: PAGE_ID, parentPageId: null, spaceId: 3 },
      { spaceId: 3 },
    );
    const auth = makeAuth();
    const svc = new KbPageTreeService(db, audit, auth as never, {} as never, new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never));

    await svc.move(makeUser("org-space-move-same"), PAGE_ID, {
      parentPageId: TARGET_ID,
      index: 0,
    });

    expect(auth.assertSpaceAccess).not.toHaveBeenCalled();
  });
});

describe("KbPageTreeService.move — the moved page is queued for reindexing", () => {
  const ORG = "org-move-reindex";
  const PAGE_ID = 80;
  const TARGET_ID = 81;

  async function moveAcrossSpaces() {
    const made = makeMoveDb(
      { id: PAGE_ID, parentPageId: null, spaceId: 1 },
      { spaceId: 2 },
    );
    const svc = new KbPageTreeService(made.db, audit, makeAuth() as never, {} as never, new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never));
    await svc.move(makeUser(ORG), PAGE_ID, { parentPageId: TARGET_ID, index: 0 });
    return made;
  }

  function emittedEvent(made: { txValues: jest.Mock }) {
    return made.txValues.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  }

  it("writes the event into outbox_events inside the same transaction as the page update", async () => {
    const made = await moveAcrossSpaces();
    expect(made.txInsert).toHaveBeenCalledTimes(1);
    expect(made.txInsert).toHaveBeenCalledWith(outboxEvents);
    expect(made.updateWhere).toHaveBeenCalled();
  });

  it("emits kb.content.index for the moved page so a space change cannot leave a stale index", async () => {
    const made = await moveAcrossSpaces();
    const event = emittedEvent(made);
    expect(event?.eventType).toBe("kb.content.index");
    expect(event?.aggregateType).toBe("kb_page");
    expect(event?.aggregateId).toBe(String(PAGE_ID));
  });

  it("scopes the event to the acting org, so a consumer cannot reindex into another tenant", async () => {
    const made = await moveAcrossSpaces();
    expect(emittedEvent(made)?.organizationId).toBe(ORG);
  });

  it("carries the post-move content and acl revisions the indexer reads", async () => {
    const made = await moveAcrossSpaces();
    const payload = emittedEvent(made)?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({
      contentType: "page",
      contentId: PAGE_ID,
      contentRevision: 7,
      aclRevision: 11,
    });
  });

  it("emits nothing when the move is refused for the target space", async () => {
    const made = makeMoveDb(
      { id: PAGE_ID, parentPageId: null, spaceId: 1 },
      { spaceId: 2 },
    );
    const auth = makeAuth();
    auth.assertSpaceAccess.mockRejectedValue(new NotFoundException("Space not found"));
    const svc = new KbPageTreeService(made.db, audit, auth as never, {} as never, new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never));

    await expect(
      svc.move(makeUser(ORG), PAGE_ID, { parentPageId: TARGET_ID, index: 0 }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(made.txInsert).not.toHaveBeenCalled();
  });
});

function makeMember(orgId: string, membershipId: number): CurrentUserContext {
  return {
    orgId,
    userId: "user-real",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId, isOrgOwner: false },
  } as unknown as CurrentUserContext;
}

describe("KbPageTreeService.move — the space check calls the canonical auth seam", () => {
  it("BITE: refuses a cross-space move when auth.assertSpaceAccess denies access to the target space", async () => {
    const PAGE_ID = 70;
    const TARGET_ID = 71;
    const { db, transaction } = makeMoveDb(
      { id: PAGE_ID, parentPageId: null, spaceId: 1 },
      { spaceId: 2 },
    );
    const auth = makeAuth();
    auth.assertSpaceAccess.mockRejectedValue(new NotFoundException("Space not found"));
    const svc = new KbPageTreeService(db, audit, auth as never, {} as never, new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never));

    await expect(
      svc.move(makeMember("org-real-move", 42), PAGE_ID, {
        parentPageId: TARGET_ID,
        index: 0,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(transaction).not.toHaveBeenCalled();
  });

  it("positive control: the move proceeds once auth.assertSpaceAccess grants access to the target space", async () => {
    const PAGE_ID = 72;
    const TARGET_ID = 73;
    const { db, updateWhere } = makeMoveDb(
      { id: PAGE_ID, parentPageId: null, spaceId: 1 },
      { spaceId: 2 },
    );
    const auth = makeAuth();
    const svc = new KbPageTreeService(db, audit, auth as never, {} as never, new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never));

    await svc.move(makeMember("org-real-move-granted", 42), PAGE_ID, {
      parentPageId: TARGET_ID,
      index: 0,
    });

    expect(updateWhere).toHaveBeenCalled();
  });
});
