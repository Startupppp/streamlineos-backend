import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageTreeService } from "./kb-page-tree.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbPageTreeService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", isOrgOwner: false } as never;
  }

  const audit = {} as never;
  const makeAuth = () => ({
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "edit", via: "admin" }),
  });

  function makeDb() {
    const wheres: unknown[] = [];
    const makeJoinChain = (): Record<string, unknown> => {
      const chain: Record<string, unknown> = {
        where: jest.fn().mockImplementation((w: unknown) => {
          wheres.push(w);
          return Promise.resolve([]);
        }),
        orderBy: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([]) })),
      };
      chain.innerJoin = jest.fn().mockReturnValue(chain);
      chain.leftJoin = jest.fn().mockReturnValue(chain);
      return chain;
    };
    return {
      db: {
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockImplementation(() => ({
            ...makeJoinChain(),
            where: jest.fn().mockImplementation((w: unknown) => {
              wheres.push(w);
              return Object.assign(Promise.resolve([]), {
                orderBy: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([]) })),
              });
            }),
          })),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  it("scopes page tree query to the requesting org (cross-tenant isolation)", async () => {
    const { db, wheres } = makeDb();
    const svc = new KbPageTreeService(db, audit, makeAuth() as never, {} as never);

    await svc.getTree(makeUser(ATTACKER));

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns page tree for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const svc = new KbPageTreeService(db, audit, makeAuth() as never, {} as never);

    const result = await svc.getTree(makeUser(OWNER));

    expect(Array.isArray(result)).toBe(true);
  });

  it("softDelete authorizes with action 'manage', not 'view' — a viewer must not trash a page", async () => {
    const PAGE_ID = 42;
    const orgId = "org-softdelete-test";
    const updateWhere = jest.fn().mockResolvedValue([]);
    const txUpdate = jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) });
    const txExecute = jest.fn().mockResolvedValue([{ id: PAGE_ID }]);
    const txDelete = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
    const tx = { execute: txExecute, update: txUpdate, delete: txDelete };
    const db = {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID, deletedAt: null, title: "T" }),
        },
      },
      transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as Db;
    const auth = makeAuth();
    const auditWithLog = { log: jest.fn() } as never;
    const svc = new KbPageTreeService(db, auditWithLog, auth as never, {} as never);

    await svc.softDelete(makeUser(orgId), PAGE_ID);

    expect(auth.assertPageAccess).toHaveBeenCalledWith(expect.anything(), PAGE_ID, "manage");
  });

  it("move authorizes with action 'edit', not 'view' — a viewer must not reposition a page in the tree", async () => {
    const PAGE_ID = 43;
    const orgId = "org-move-test";
    const updateWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: PAGE_ID, parentPageId: null, sortOrder: 100 }]) });
    const txUpdate = jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) });
    const txSelect = jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) }) }) });
    const tx = { update: txUpdate, select: txSelect };
    const db = {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID, parentPageId: null }),
        },
      },
      transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as Db;
    const auth = makeAuth();
    const svc = new KbPageTreeService(db, audit, auth as never, {} as never);

    await svc.move(makeUser(orgId), PAGE_ID, { parentPageId: null, index: 0 });

    expect(auth.assertPageAccess).toHaveBeenCalledWith(expect.anything(), PAGE_ID, "edit");
  });

  function makeMoveDb(PAGE_ID: number) {
    const updateWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: PAGE_ID, parentPageId: null, sortOrder: 100 }]) });
    const txUpdate = jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) });
    const txSelect = jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) }) }) });
    const transaction = jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn({ update: txUpdate, select: txSelect }));
    const db = {
      query: { kbPages: { findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID, parentPageId: null }) } },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
      transaction,
    } as unknown as Db;
    return { db, transaction, txUpdate };
  }

  it("move authorizes the TARGET parent for 'edit', not only the page being moved", async () => {
    const PAGE_ID = 44;
    const TARGET_ID = 99;
    const { db } = makeMoveDb(PAGE_ID);
    const auth = makeAuth();
    const svc = new KbPageTreeService(db, audit, auth as never, {} as never);

    await svc.move(makeUser("org-move-target"), PAGE_ID, { parentPageId: TARGET_ID, index: 0 });

    expect(auth.assertPageAccess).toHaveBeenCalledWith(expect.anything(), PAGE_ID, "edit");
    expect(auth.assertPageAccess).toHaveBeenCalledWith(expect.anything(), TARGET_ID, "edit");
  });

  it("move refuses a target parent the actor cannot reach, and writes nothing", async () => {
    const PAGE_ID = 45;
    const TARGET_ID = 100;
    const { db, transaction, txUpdate } = makeMoveDb(PAGE_ID);
    const auth = makeAuth();
    auth.assertPageAccess.mockImplementation(async (_u: unknown, id: number) => {
      if (id === TARGET_ID) throw new NotFoundException("Page not found");
      return { orgId: "o1", pageId: id, action: "edit", via: "admin" };
    });
    const svc = new KbPageTreeService(db, audit, auth as never, {} as never);

    await expect(
      svc.move(makeUser("org-move-denied"), PAGE_ID, { parentPageId: TARGET_ID, index: 0 }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(transaction).not.toHaveBeenCalled();
    expect(txUpdate).not.toHaveBeenCalled();
  });
});
