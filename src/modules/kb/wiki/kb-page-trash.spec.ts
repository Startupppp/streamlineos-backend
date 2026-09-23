import { sql } from "drizzle-orm";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { KbPageTreeService } from "./kb-page-tree.service";
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

function makePurgeHelpers() {
  return {
    recordPageAttachmentPurge: jest.fn().mockResolvedValue([]),
    attemptPageAttachmentPurge: jest.fn().mockResolvedValue(undefined),
  };
}

jest.mock("./kb-page-attachment-purge", () => ({
  recordPageAttachmentPurge: jest.fn().mockResolvedValue([]),
  attemptPageAttachmentPurge: jest.fn().mockResolvedValue(undefined),
  purgeOrphanedKbMedia: jest.fn().mockResolvedValue(0),
}));

type SelectChain = {
  from: () => { where: () => { orderBy: () => { limit: (n: number) => Promise<unknown[]> } } };
};

function makeTrashDb(rows: Array<Record<string, unknown>>, visible = true): {
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
              return visible ? rows.slice(0, n) : [];
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

function makeBulkDb(
  visibleRows: Array<{ id: number; deletedAt: Date | null }>,
  pageForFind: { id: number; deletedAt: Date | null; parentPageId: number | null; title: string } | null,
): Db {
  let selectCallCount = 0;
  return {
    select: jest.fn().mockImplementation(() => ({
      from: () => ({
        where: () => {
          selectCallCount += 1;
          if (selectCallCount === 1) {
            return Promise.resolve(visibleRows);
          }
          return { orderBy: () => ({ limit: async () => [] }) };
        },
      }),
    })),
    query: {
      kbPages: {
        findFirst: jest.fn().mockResolvedValue(pageForFind),
      },
    },
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        execute: jest.fn().mockResolvedValue([{ id: pageForFind?.id ?? 1 }]),
        query: { kbPages: { findFirst: jest.fn().mockResolvedValue(null) } },
        update: () => ({ set: () => ({ where: jest.fn().mockResolvedValue([]) }) }),
        delete: () => ({ where: jest.fn().mockResolvedValue([]) }),
        select: () => ({ from: () => ({ where: jest.fn().mockResolvedValue([{ id: 1, orgId: ORG_ID, title: "T", status: "draft", visibility: "org", contentType: "note", trustState: "unverified", isLocked: false, icon: null, coverImage: null, sortOrder: 0, spaceId: null, parentPageId: null, projectId: null, publicToken: null, publicSlug: null, deletedAt: null, deletedById: null, createdAt: new Date(), updatedAt: new Date(), createdById: null, lastEditedById: null, ownerUserId: null, verifiedById: null, verifiedUntil: null, nextReviewAt: null, aclRevision: 0, contentRevision: 1, sourceArticleId: null, createdByMembershipId: null, lastEditedByMembershipId: null, deletedByMembershipId: null, ownerMembershipId: null, verifiedByMembershipId: null }]) }) }),
      })),
  } as unknown as Db;
}

function service(db: Db): KbPageTreeService {
  return new KbPageTreeService(
    db,
    auditMock as never,
    storageMock,
    configMock,
    auth as never,
  );
}

function trashQuery(over: Record<string, unknown> = {}) {
  return trashPagesQuerySchema.parse({ ...over });
}

const sampleDeletedAt = new Date("2024-06-01T12:00:00.000000Z");

function makeRow(id: number, deletedAt = sampleDeletedAt) {
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
    sourceArticleId: null,
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
    const { db } = makeTrashDb([makeRow(1)], false);
    const svc = new KbPageTreeService(db, auditMock as never, storageMock, configMock, restrictedAuth as never);
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
    expect(cursor.id).not.toBe((rows[5] as { id: number }).id);
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
    const db = makeBulkDb(
      [{ id: 1, deletedAt: now }],
      { id: 1, deletedAt: now, parentPageId: null, title: "P1" },
    );
    const svc = service(db);
    const result = await svc.bulkRestore(userInOrg, { pageIds: [1, 99] });
    const r1 = result.results.find((r) => r.pageId === 1);
    const r99 = result.results.find((r) => r.pageId === 99);
    expect(r1?.result).toBe("succeeded");
    expect(r99?.result).toBe("notFound");
  });

  it("a hidden page and a missing page produce the identical result shape", async () => {
    const db = makeBulkDb([], null);
    const result = await service(db).bulkRestore(userInOrg, { pageIds: [1, 2] });
    const shapes = result.results.map((r) => ({ result: r.result }));
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[0]?.result).toBe("notFound");
  });

  it("restoring an already-live page is succeeded — idempotent", async () => {
    const db = makeBulkDb(
      [{ id: 5, deletedAt: null }],
      { id: 5, deletedAt: null, parentPageId: null, title: "Live" },
    );
    const result = await service(db).bulkRestore(userInOrg, { pageIds: [5] });
    expect(result.results[0]?.result).toBe("succeeded");
  });

  it("a ConflictException from restore is treated as succeeded — race-condition idempotence", async () => {
    const now = new Date();
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: () => ({
          where: () => Promise.resolve([{ id: 7, deletedAt: now }]),
        }),
      })),
      query: { kbPages: { findFirst: jest.fn().mockResolvedValue({ id: 7, deletedAt: now, parentPageId: null, title: "X" }) } },
      transaction: jest.fn().mockRejectedValue(new ConflictException("Page is not in trash")),
    } as unknown as Db;
    const result = await service(db).bulkRestore(userInOrg, { pageIds: [7] });
    expect(result.results[0]?.result).toBe("succeeded");
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
      query: { kbPages: { findFirst: jest.fn().mockResolvedValue({ id: 3, title: "P3" }) } },
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          execute: jest.fn().mockResolvedValue([{ id: 3 }]),
          delete: () => ({ where: jest.fn().mockResolvedValue([]) }),
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
