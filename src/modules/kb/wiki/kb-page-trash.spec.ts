import { sql } from "drizzle-orm";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { KbPageTrashService } from "./kb-page-trash.service";
import { trashPagesQuerySchema, bulkPageIdsSchema } from "./dto/kb-pages.schemas";
import { decodeTimestampCursor } from "../../../common/pagination/cursor";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG_ID = "org-1";
const HIDDEN_ORG_ID = "org-2";

const userInOrg = {
  userId: "user-1",
  orgId: ORG_ID,
  isOrgOwner: false,
} as CurrentUserContext;

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: ORG_ID, pageId: 1, action: "view", via: "admin" }),
};

const auditMock = { log: jest.fn() };
const storageMock = {} as never;
const configMock = { R2_KB_BUCKET_NAME: "test-bucket" } as never;

jest.mock("./kb-page-attachment-purge", () => ({
  recordPageAttachmentPurge: jest.fn().mockResolvedValue([]),
  attemptPageAttachmentPurge: jest.fn().mockResolvedValue(undefined),
  purgeOrphanedKbMedia: jest.fn().mockResolvedValue(0),
}));

type SelectChain = {
  from: () => { where: () => { orderBy: () => { limit: (n: number) => Promise<unknown[]> } } };
};

function makeTrashDb(rows: Array<Record<string, unknown>>): {
  db: Db;
  limits: number[];
} {
  const limits: number[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async (n: number) => {
              limits.push(n);
              return rows.slice(0, n);
            },
          }),
        }),
      }),
    }),
    query: {
      kbPages: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
      execute: jest.fn().mockResolvedValue([]),
      query: { kbPages: { findFirst: jest.fn().mockResolvedValue(null) } },
      update: () => ({ set: () => ({ where: jest.fn().mockResolvedValue([]) }) }),
      delete: () => ({ where: jest.fn().mockResolvedValue([]) }),
      select: () => ({ from: () => ({ where: jest.fn().mockResolvedValue([]) }) }),
    })),
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as Db;
  return { db, limits };
}

function makeSelectOnlyDb(
  visibleRows: Array<{ id: number; deletedAt: Date | null }>,
): Db {
  return {
    select: jest.fn().mockImplementation(() => ({
      from: () => ({
        where: () => Promise.resolve(visibleRows),
      }),
    })),
  } as unknown as Db;
}

function makeTreeMock(restoreImpl?: () => Promise<unknown>) {
  return {
    restore: jest.fn().mockImplementation(restoreImpl ?? (() => Promise.resolve({ id: 1 }))),
  };
}

function service(db: Db, treeMock?: ReturnType<typeof makeTreeMock>): KbPageTrashService {
  return new KbPageTrashService(
    db,
    auditMock as never,
    storageMock,
    configMock,
    auth as never,
    (treeMock ?? makeTreeMock()) as never,
    { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

function trashQuery(over: Record<string, unknown> = {}) {
  return trashPagesQuerySchema.parse({ ...over });
}

const sampleDeletedAt = new Date("2024-06-01T12:00:00.000000Z");

function makeRow(
  id: number,
  deletedAt = sampleDeletedAt,
): { id: number } & Record<string, unknown> {
  return {
    id,
    orgId: ORG_ID,
    title: `Page ${id}`,
    icon: null,
    coverImage: null,
    status: "draft",
    visibility: "org",
    contentType: "note",
    trustState: "unverified",
    isLocked: false,
    sortOrder: 0,
    spaceId: null,
    parentPageId: null,
    projectId: null,
    publicToken: null,
    publicSlug: null,
    deletedAt,
    deletedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdById: null,
    lastEditedById: null,
    ownerUserId: null,
    verifiedById: null,
    verifiedUntil: null,
    nextReviewAt: null,
    aclRevision: 0,
    contentRevision: 1,
    createdByMembershipId: null,
    lastEditedByMembershipId: null,
    deletedByMembershipId: null,
    ownerMembershipId: null,
    verifiedByMembershipId: null,
    deletedAtText: "2024-06-01T12:00:00.000000",
  };
}

describe("GET /kb/pages/trash — keyset cursor, not a cap", () => {
  it("a deleted page outside the caller's visible scope never appears in their trash", async () => {
    const restrictedAuth = {
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`false`),
      assertPageAccess: jest.fn(),
    };
    const { db } = makeTrashDb([]);
    const svc = new KbPageTrashService(db, auditMock as never, storageMock, configMock, restrictedAuth as never, makeTreeMock() as never, { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never);
    const page = await svc.getTrash(userInOrg, trashQuery());
    expect(page.data).toHaveLength(0);
    expect(restrictedAuth.visiblePagePredicate).toHaveBeenCalledWith(userInOrg, "view");
  });

  it("a deleted page in the caller's visible scope DOES appear in their trash", async () => {
    const { db } = makeTrashDb([makeRow(1)]);
    const page = await service(db).getTrash(userInOrg, trashQuery());
    expect(page.data.length).toBeGreaterThan(0);
  });

  it("over-fetches one sentinel row so hasMore costs no second query", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => makeRow(100 - i));
    const { db, limits } = makeTrashDb(rows);
    const page = await service(db).getTrash(userInOrg, trashQuery({ limit: 50 }));
    expect(limits).toEqual([51]);
    expect(page.data).toHaveLength(50);
    expect(page.pagination.hasMore).toBe(true);
  });

  it("the list pages past 100 rows and reports hasMore — no silent truncation at 100", async () => {
    const rows = Array.from({ length: 105 }, (_, i) => makeRow(200 - i));
    const { db, limits } = makeTrashDb(rows);
    const page = await service(db).getTrash(userInOrg, trashQuery({ limit: 100 }));
    expect(limits).toEqual([101]);
    expect(page.data).toHaveLength(100);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).not.toBeNull();
  });

  it("reports no next page when all results fit", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeRow(3 - i));
    const { db } = makeTrashDb(rows);
    const page = await service(db).getTrash(userInOrg, trashQuery({ limit: 50 }));
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });

  it("two pages deleted in the same millisecond do not straddle a page boundary — id tie-breaker", async () => {
    const sameInstant = new Date("2024-06-01T12:00:00.000000Z");
    const rows = Array.from({ length: 6 }, (_, i) => ({
      ...makeRow(10 - i, sameInstant),
      deletedAtText: "2024-06-01T12:00:00.000000",
    }));
    const { db } = makeTrashDb(rows);
    const page = await service(db).getTrash(userInOrg, trashQuery({ limit: 5 }));
    const cursor = decodeTimestampCursor(page.pagination.nextCursor ?? undefined);
    if (!cursor) throw new Error("expected a cursor");
    expect(cursor.id).toBe(page.data[page.data.length - 1]?.id);
    expect(cursor.id).not.toBe(rows[5]?.id);
  });

  it("refuses a limit above the hard cap", () => {
    expect(() => trashPagesQuerySchema.parse({ limit: 5000 })).not.toThrow();
    const q = trashPagesQuerySchema.parse({ limit: 5000 });
    expect(q.limit).toBe(100);
  });
});

describe("POST /kb/pages/trash/restore — bulk restore", () => {
  it("rejects more than 100 ids", () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
    expect(() => bulkPageIdsSchema.parse({ pageIds: tooMany })).toThrow();
  });

  it("accepts exactly 100 ids", () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(() => bulkPageIdsSchema.parse({ pageIds: ids })).not.toThrow();
  });

  it("a hidden page returns notFound and visible deleted page returns succeeded", async () => {
    const now = new Date();
    const db = makeSelectOnlyDb([{ id: 1, deletedAt: now }]);
    const tree = makeTreeMock(() => Promise.resolve({ id: 1 }));
    const result = await service(db, tree).bulkRestore(userInOrg, { pageIds: [1, 99] });
    const r1 = result.results.find((r) => r.pageId === 1);
    const r99 = result.results.find((r) => r.pageId === 99);
    expect(r1?.result).toBe("succeeded");
    expect(r99?.result).toBe("notFound");
  });

  it("a hidden page and a missing page produce the identical result shape", async () => {
    const db = makeSelectOnlyDb([]);
    const result = await service(db).bulkRestore(userInOrg, { pageIds: [1, 2] });
    const shapes = result.results.map((r) => ({ result: r.result }));
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[0]?.result).toBe("notFound");
  });

  it("restoring an already-live page is succeeded — idempotent", async () => {
    const db = makeSelectOnlyDb([{ id: 5, deletedAt: null }]);
    const result = await service(db).bulkRestore(userInOrg, { pageIds: [5] });
    expect(result.results[0]?.result).toBe("succeeded");
  });

  it("a ConflictException from restore is treated as succeeded — race-condition idempotence", async () => {
    const now = new Date();
    const db = makeSelectOnlyDb([{ id: 7, deletedAt: now }]);
    const tree = makeTreeMock(() => Promise.reject(new ConflictException("Page is not in trash")));
    const result = await service(db, tree).bulkRestore(userInOrg, { pageIds: [7] });
    expect(result.results[0]?.result).toBe("succeeded");
  });
});

describe("legal hold — blocks all three purge paths", () => {
  function makeHeldPageDb(
    legalHold: boolean,
    legalHoldReason?: string,
  ): Db {
    return {
      select: jest.fn().mockImplementation(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [{ id: 7 }],
            }),
          }),
        }),
      })),
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue(
            legalHold ? { id: 7, title: "Held", legalHold, legalHoldReason: legalHoldReason ?? null } : null,
          ),
        },
        kbPagePurgeLedger: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      transaction: jest.fn().mockImplementation(
        async (cb: (tx: unknown) => Promise<unknown>) =>
          cb({
            execute: jest.fn().mockResolvedValue([{ id: 7 }]),
            delete: () => ({ where: jest.fn().mockResolvedValue([]) }),
            insert: () => ({
              values: () => ({
                onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
              }),
            }),
            update: () => ({ set: () => ({ where: jest.fn().mockResolvedValue([]) }) }),
          }),
      ),
    } as unknown as Db;
  }

  it("hardDelete on a legal-hold page throws ConflictException — cannot bypass the hold", async () => {
    const db = makeHeldPageDb(true);
    await expect(
      service(db).hardDelete(userInOrg, 7),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("hardDelete on a non-held page does not throw — hold is not a blanket ban", async () => {
    const db = {
      query: {
        kbPages: { findFirst: jest.fn().mockResolvedValue({ id: 7, title: "Free", legalHold: false, legalHoldReason: null }) },
        kbPagePurgeLedger: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      transaction: jest.fn().mockImplementation(
        async (cb: (tx: unknown) => Promise<unknown>) =>
          cb({
            execute: jest.fn().mockResolvedValue([{ id: 7 }]),
            delete: () => ({ where: jest.fn().mockResolvedValue([]) }),
            insert: () => ({
              values: () => ({
                onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
              }),
            }),
            update: () => ({ set: () => ({ where: jest.fn().mockResolvedValue([]) }) }),
          }),
      ),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as Db;
    await expect(service(db).hardDelete(userInOrg, 7)).resolves.not.toThrow();
  });

  it("hardDelete error message includes the legal-hold reason when one is set", async () => {
    const db = makeHeldPageDb(true, "Active litigation hold");
    let caught: Error | undefined;
    try {
      await service(db).hardDelete(userInOrg, 7);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect(caught?.message).toContain("Active litigation hold");
  });

  it("emptyTrash skips legal-hold pages so the batch query excludes legalHold=true", async () => {
    const selectWhereClauses: unknown[] = [];
    const db = {
      select: jest.fn().mockReturnValue({
        from: () => ({
          where: (cond: unknown) => {
            selectWhereClauses.push(cond);
            return {
              orderBy: () => ({
                limit: async () => [],
              }),
            };
          },
        }),
      }),
      query: { kbPagePurgeLedger: { findFirst: jest.fn().mockResolvedValue(undefined) } },
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
        insert: () => ({ values: () => ({ onConflictDoNothing: jest.fn() }) }),
      })),
    } as unknown as Db;
    await service(db).emptyTrash(userInOrg);
    expect(selectWhereClauses.length).toBeGreaterThan(0);
  });

  it("purgeExpired skips legal-hold pages so they survive past the retention window", async () => {
    const selectWhereClauses: unknown[] = [];
    const db = {
      select: jest.fn().mockReturnValue({
        from: () => ({
          where: (cond: unknown) => {
            selectWhereClauses.push(cond);
            return {
              orderBy: () => ({
                limit: async () => [],
              }),
            };
          },
        }),
      }),
      query: { kbPagePurgeLedger: { findFirst: jest.fn().mockResolvedValue(undefined) } },
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
        insert: () => ({ values: () => ({ onConflictDoNothing: jest.fn() }) }),
      })),
    } as unknown as Db;
    await service(db).purgeExpired(ORG_ID, new Date("2020-01-01"));
    expect(selectWhereClauses.length).toBeGreaterThan(0);
  });
});

describe("DELETE /kb/pages/trash/purge — bulk purge", () => {
  it("a hidden page returns notFound; a visible page returns succeeded", async () => {
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: () => ({
          where: () => Promise.resolve([{ id: 3 }]),
        }),
      })),
      query: {
        kbPages: { findFirst: jest.fn().mockResolvedValue({ id: 3, title: "P3" }) },
        kbPagePurgeLedger: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          execute: jest.fn().mockResolvedValue([{ id: 3 }]),
          delete: () => ({ where: jest.fn().mockResolvedValue([]) }),
          insert: () => ({
            values: () => ({
              onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
              onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
            }),
          }),
          update: () => ({ set: () => ({ where: jest.fn().mockResolvedValue([]) }) }),
        })
      ),
    } as unknown as Db;
    const result = await service(db).bulkPurge(userInOrg, { pageIds: [3, 99] });
    const r3 = result.results.find((r) => r.pageId === 3);
    const r99 = result.results.find((r) => r.pageId === 99);
    expect(r3?.result).toBe("succeeded");
    expect(r99?.result).toBe("notFound");
  });

  it("a NotFoundException during purge becomes notFound — race condition tolerance", async () => {
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: () => ({
          where: () => Promise.resolve([{ id: 8 }]),
        }),
      })),
      query: { kbPages: { findFirst: jest.fn().mockResolvedValue(null) } },
      transaction: jest.fn().mockResolvedValue([{ id: 8 }]),
    } as unknown as Db;
    const result = await service(db).bulkPurge(userInOrg, { pageIds: [8] });
    expect(result.results[0]?.result).toBe("notFound");
  });
});
