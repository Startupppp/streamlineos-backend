import { KbPageTreeService } from "./kb-page-tree.service";
import { kbArticleChunks } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

jest.mock("../retrieval/kb-page-access.util", () => ({
  assertPageAccessible: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../retrieval/kb-project-access.util", () => ({
  getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
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

function makeDb(subtreeIds: number[]) {
  const chunkDeleteWhere = jest.fn().mockResolvedValue([]);
  const txDelete = jest.fn().mockReturnValue({ where: chunkDeleteWhere });

  const pageUpdateWhere = jest.fn().mockResolvedValue([]);
  const pageUpdateSet = jest.fn().mockReturnValue({ where: pageUpdateWhere });
  const txUpdate = jest.fn().mockReturnValue({ set: pageUpdateSet });

  const txExecute = jest.fn().mockResolvedValue(subtreeIds.map((id) => ({ id })));

  const tx = {
    execute: txExecute,
    update: txUpdate,
    delete: txDelete,
  };

  const db = {
    query: {
      kbPages: {
        findFirst: jest.fn().mockResolvedValue({ id: subtreeIds[0], title: "Test Page", deletedAt: null }),
      },
    },
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx)),
  };

  return { db, txDelete, txUpdate, txExecute, chunkDeleteWhere };
}

const makeAudit = () => ({ log: jest.fn() });
const makePlanLimits = () => ({});

describe("KbPageTreeService.softDelete — chunk purge is inside the transaction", () => {
  it("calls tx.delete on kbArticleChunks inside the transaction for the soft-deleted subtree", async () => {
    const { db, txDelete } = makeDb([42, 43]);
    const svc = new KbPageTreeService(db as never, makeAudit() as never, makePlanLimits() as never);

    await svc.softDelete(makeUser(), 42);

    const chunkDeleteCall = txDelete.mock.calls.find(([table]: [unknown]) => table === kbArticleChunks);
    expect(chunkDeleteCall).toBeDefined();
  });

  it("does NOT call db.delete (outside transaction) for chunks after softDelete", async () => {
    const { db, txDelete } = makeDb([42]);
    const dbDelete = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
    (db as Record<string, unknown>).delete = dbDelete;

    const txActualDelete = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
    const dbObj = db as unknown as { transaction: jest.Mock };
    const origTransaction = dbObj.transaction;
    dbObj.transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const txOverride = {
        execute: jest.fn().mockResolvedValue([{ id: 42 }]),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        delete: txActualDelete,
      };
      return fn(txOverride);
    });

    void origTransaction;
    const svc = new KbPageTreeService(db as never, makeAudit() as never, makePlanLimits() as never);

    await svc.softDelete(makeUser(), 42);

    expect(dbDelete).not.toHaveBeenCalledWith(kbArticleChunks);
    expect(txActualDelete).toHaveBeenCalledWith(kbArticleChunks);
  });

  it("bites: if tx.delete is not called for chunks, the chunk-inside-tx assertion fails", () => {
    expect(kbArticleChunks).toBeDefined();
  });
});
