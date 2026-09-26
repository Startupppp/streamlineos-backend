import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbPageTreeService } from "./kb-page-tree.service";
import { KbAccessService } from "../core/kb-access.service";
import type { AccessService } from "../../access/access.service";
import type { CacheService } from "../../../common/cache/cache.service";
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
  };
}

function makeMoveDb(pageRow: { id: number; parentPageId: number | null; spaceId: number | null }, targetParentRow: { spaceId: number | null } | undefined) {
  const findFirst = jest
    .fn()
    .mockResolvedValueOnce(pageRow)
    .mockResolvedValueOnce(targetParentRow);
  const updateWhere = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([{ id: pageRow.id, parentPageId: null, sortOrder: 100, spaceId: targetParentRow?.spaceId ?? pageRow.spaceId }]),
  });
  const txUpdate = jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) });
  const txSelect = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) }) }),
  });
  const transaction = jest
    .fn()
    .mockImplementation(async (fn: (t: unknown) => unknown) => fn({ update: txUpdate, select: txSelect }));
  const db = {
    query: { kbPages: { findFirst } },
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    transaction,
  } as unknown as Db;
  return { db, transaction, txUpdate, updateWhere };
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
    const kbAccess = {
      assertSpaceAccessible: jest.fn().mockResolvedValue(undefined),
    } as unknown as KbAccessService;
    const svc = new KbPageTreeService(db, audit, auth as never, {} as never, kbAccess);

    await svc.move(makeUser("org-space-move"), PAGE_ID, {
      parentPageId: TARGET_ID,
      index: 0,
    });

    expect(kbAccess.assertSpaceAccessible).toHaveBeenCalledWith(expect.anything(), 2);
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
    const kbAccess = {
      assertSpaceAccessible: jest.fn().mockRejectedValue(new NotFoundException("Space not found")),
    } as unknown as KbAccessService;
    const svc = new KbPageTreeService(db, audit, auth as never, {} as never, kbAccess);

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
    const kbAccess = {
      assertSpaceAccessible: jest.fn().mockResolvedValue(undefined),
    } as unknown as KbAccessService;
    const svc = new KbPageTreeService(db, audit, auth as never, {} as never, kbAccess);

    await svc.move(makeUser("org-space-move-same"), PAGE_ID, {
      parentPageId: TARGET_ID,
      index: 0,
    });

    expect(kbAccess.assertSpaceAccessible).not.toHaveBeenCalled();
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

function makeRealKbAccessService(
  spaces: { id: number; audience: string }[],
  grantedSpaceIds: number[],
): KbAccessService {
  const selectResults: unknown[][] = [spaces, []];
  const makeChain = (result: unknown[]) => {
    const chain: Record<string, jest.Mock> = {};
    chain.from = jest.fn(() => chain);
    chain.innerJoin = jest.fn(() => chain);
    chain.where = jest.fn(() => Promise.resolve(result));
    return chain;
  };
  const db = {
    select: jest.fn(() => makeChain(selectResults.shift() ?? [])),
    selectDistinct: jest.fn(() =>
      makeChain(grantedSpaceIds.map((spaceId) => ({ spaceId }))),
    ),
  };
  const access = {
    holds: jest.fn().mockResolvedValue(false),
    getPermissionsVersion: jest.fn().mockResolvedValue(1),
  } as unknown as AccessService;
  const cache = {
    cachedVersioned: jest
      .fn()
      .mockImplementation((_ns: unknown, _key: unknown, fn: () => unknown) => fn()),
  } as unknown as CacheService;
  return new KbAccessService(db as never, cache, access);
}

describe("KbPageTreeService.move — the space check is a real authorization decision, not a mock interaction", () => {
  it("BITE: refuses a cross-space move when the real KbAccessService reports the target space is not accessible", async () => {
    const PAGE_ID = 70;
    const TARGET_ID = 71;
    const { db, transaction } = makeMoveDb(
      { id: PAGE_ID, parentPageId: null, spaceId: 1 },
      { spaceId: 2 },
    );
    const auth = makeAuth();
    const kbAccess = makeRealKbAccessService(
      [
        { id: 1, audience: "internal" },
        { id: 2, audience: "internal" },
      ],
      [1],
    );
    const svc = new KbPageTreeService(db, audit, auth as never, {} as never, kbAccess);

    await expect(
      svc.move(makeMember("org-real-move", 42), PAGE_ID, {
        parentPageId: TARGET_ID,
        index: 0,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(transaction).not.toHaveBeenCalled();
  });

  it("positive control: the same real KbAccessService permits the cross-space move once membership grants both spaces", async () => {
    const PAGE_ID = 72;
    const TARGET_ID = 73;
    const { db, updateWhere } = makeMoveDb(
      { id: PAGE_ID, parentPageId: null, spaceId: 1 },
      { spaceId: 2 },
    );
    const auth = makeAuth();
    const kbAccess = makeRealKbAccessService(
      [
        { id: 1, audience: "internal" },
        { id: 2, audience: "internal" },
      ],
      [1, 2],
    );
    const svc = new KbPageTreeService(db, audit, auth as never, {} as never, kbAccess);

    await svc.move(makeMember("org-real-move-granted", 42), PAGE_ID, {
      parentPageId: TARGET_ID,
      index: 0,
    });

    expect(updateWhere).toHaveBeenCalled();
  });
});
