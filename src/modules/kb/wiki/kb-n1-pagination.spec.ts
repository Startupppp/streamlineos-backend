import { KbPageCommentsService } from "./kb-page-comments.service";
import { KbMembersService } from "./kb-members.service";
import { KbPageVisitsService } from "./kb-page-visits.service";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import { decodeCursor } from "../../../common/pagination/cursor";
import type { Db } from "../../../db/drizzle.module";
import { sql } from "drizzle-orm";
import type { KbAccessService } from "../core/kb-access.service";
import type { KbIndexingService } from "../retrieval/kb-indexing.service";

const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
const access = { holds: jest.fn().mockResolvedValue(false) } as never;
const authMock = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue(undefined),
};

function makeUser(orgId = "org-1") {
  return {
    orgId,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 1 },
  } as never;
}

function makeCommentRow(id: number, createdAt = new Date(Date.UTC(2024, 0, 1, 0, 0, id))) {
  return {
    comment: {
      id,
      orgId: "org-1",
      pageId: 5,
      authorId: "user-1",
      parentId: null,
      content: "test",
      anchorBlockIndex: null,
      anchorQuote: null,
      resolvedAt: null,
      createdAt,
      updatedAt: new Date(),
    },
    authorName: "Alice",
    authorEmail: null,
  };
}

function makeCommentsListDb(rowCount: number) {
  const mockRows = Array.from({ length: rowCount }, (_, i) => makeCommentRow(i + 1));
  const limitFn = jest.fn().mockResolvedValue(mockRows);
  const chain = {
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: limitFn,
  };
  const db = {
    query: { kbPages: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) } },
    select: jest.fn().mockReturnValue(chain),
  } as unknown as Db;
  return { db, limitFn, mockRows };
}

describe("KbPageCommentsService.list — BE-24 / BE-25 cursor pagination", () => {
  it("returns a CursorPage shape not a plain array", async () => {
    const { db } = makeCommentsListDb(0);
    const svc = new KbPageCommentsService(db, dispatch, access, authMock as never);

    const result = await svc.list(makeUser(), 5);

    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("pagination");
    expect(Array.isArray((result as { data: unknown }).data)).toBe(true);
  });

  it("hasMore is true when rows exceed the limit so the caller knows to request the next page", async () => {
    const { db } = makeCommentsListDb(51);
    const svc = new KbPageCommentsService(db, dispatch, access, authMock as never);

    const result = await svc.list(makeUser(), 5);

    expect((result as { pagination: { hasMore: boolean } }).pagination.hasMore).toBe(true);
  });

  it("hasMore is false when rows fit within the limit (positive control — hasMore is not always true)", async () => {
    const { db } = makeCommentsListDb(10);
    const svc = new KbPageCommentsService(db, dispatch, access, authMock as never);

    const result = await svc.list(makeUser(), 5);

    expect((result as { pagination: { hasMore: boolean } }).pagination.hasMore).toBe(false);
  });

  it("nextCursor is null when hasMore is false so JSON serialisation does not omit the field", async () => {
    const { db } = makeCommentsListDb(10);
    const svc = new KbPageCommentsService(db, dispatch, access, authMock as never);

    const result = await svc.list(makeUser(), 5);

    expect((result as { pagination: { nextCursor: unknown } }).pagination.nextCursor).toBeNull();
  });

  it("fetches limit+1 rows from the DB so the sentinel technique can compute hasMore without a count query", async () => {
    const { db, limitFn } = makeCommentsListDb(0);
    const svc = new KbPageCommentsService(db, dispatch, access, authMock as never);

    await svc.list(makeUser(), 5);

    expect(limitFn).toHaveBeenCalledWith(51);
  });

  it("clamps an over-cap limit to PAGE_SIZE_CAP so no single request can exceed the platform ceiling", async () => {
    const { db, limitFn } = makeCommentsListDb(0);
    const svc = new KbPageCommentsService(db, dispatch, access, authMock as never);

    await svc.list(makeUser(), 5, undefined, PAGE_SIZE_CAP + 50);

    expect(limitFn).toHaveBeenCalledWith(PAGE_SIZE_CAP + 1);
  });

  it("nextCursor encodes the last row in the page so the ORDER BY and cursor stay aligned", async () => {
    const { db, mockRows } = makeCommentsListDb(51);
    const svc = new KbPageCommentsService(db, dispatch, access, authMock as never);

    const result = await svc.list(makeUser(), 5);

    const pagination = (result as { pagination: { nextCursor: string | null; hasMore: boolean } }).pagination;
    expect(pagination.hasMore).toBe(true);
    expect(pagination.nextCursor).not.toBeNull();
    const decoded = decodeCursor(pagination.nextCursor!);
    expect(decoded?.id).toBe(String(mockRows[49].comment.id));
    expect(decoded?.sortValue).toBe(mockRows[49].comment.createdAt.toISOString());
  });
});

function makeMembersDb(rowCount: number) {
  const mockRows = Array.from({ length: rowCount }, (_, i) => ({
    id: i + 1,
    orgId: "org-1",
    spaceId: 7,
    userId: `user-${i + 1}`,
    membershipId: i + 1,
    role: null,
    team: null,
    spaceRole: "viewer",
    createdAt: new Date(Date.UTC(2024, 0, i + 1)),
    userName: null,
    userEmail: null,
    userImage: null,
  }));
  const limitFn = jest.fn().mockResolvedValue(mockRows);
  const chain = {
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: limitFn,
  };
  const db = {
    query: {
      kbSpaces: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
    },
    select: jest.fn().mockReturnValue(chain),
  } as unknown as Db;
  const kbAccess = { invalidateAccessibleSpaceIds: jest.fn() } as unknown as KbAccessService;
  const indexing = { bumpSpaceAclRevision: jest.fn() } as unknown as KbIndexingService;
  const svc = new KbMembersService(db, kbAccess, indexing);
  return { svc, limitFn, mockRows };
}

describe("KbMembersService.list — BE-24 / BE-25 cursor pagination", () => {
  it("returns a CursorPage shape not a plain array", async () => {
    const { svc } = makeMembersDb(0);

    const result = await svc.list("org-1", 7);

    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("pagination");
    expect(Array.isArray((result as { data: unknown }).data)).toBe(true);
  });

  it("hasMore is true when rows exceed the limit", async () => {
    const { svc } = makeMembersDb(51);

    const result = await svc.list("org-1", 7);

    expect((result as { pagination: { hasMore: boolean } }).pagination.hasMore).toBe(true);
  });

  it("hasMore is false when rows fit within the limit (positive control)", async () => {
    const { svc } = makeMembersDb(10);

    const result = await svc.list("org-1", 7);

    expect((result as { pagination: { hasMore: boolean } }).pagination.hasMore).toBe(false);
  });

  it("fetches limit+1 rows so the sentinel technique can compute hasMore", async () => {
    const { svc, limitFn } = makeMembersDb(0);

    await svc.list("org-1", 7);

    expect(limitFn).toHaveBeenCalledWith(51);
  });

  it("clamps an over-cap limit to PAGE_SIZE_CAP", async () => {
    const { svc, limitFn } = makeMembersDb(0);

    await svc.list("org-1", 7, undefined, PAGE_SIZE_CAP + 50);

    expect(limitFn).toHaveBeenCalledWith(PAGE_SIZE_CAP + 1);
  });

  it("no longer calls .limit(500) which was five times the cap", async () => {
    const { svc, limitFn } = makeMembersDb(0);

    await svc.list("org-1", 7);

    expect(limitFn).not.toHaveBeenCalledWith(500);
  });
});

function makeBacklinksDb(linkCount: number) {
  const linkRows = Array.from({ length: linkCount }, (_, i) => ({
    id: i + 1,
    sourcePageId: i + 100,
  }));
  const linkLimitFn = jest.fn().mockResolvedValue(linkRows);
  const linkOrderByFn = jest.fn().mockReturnValue({ limit: linkLimitFn });
  const linkWhereFn = jest.fn().mockReturnValue({ orderBy: linkOrderByFn });
  const linkFromFn = jest.fn().mockReturnValue({ where: linkWhereFn });

  const pageWhereFn = jest.fn().mockResolvedValue([]);
  const pageFromFn = jest.fn().mockReturnValue({ where: pageWhereFn });

  const db = {
    select: jest.fn()
      .mockReturnValueOnce({ from: linkFromFn })
      .mockReturnValueOnce({ from: pageFromFn }),
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
    },
  } as unknown as Db;
  return { db, linkLimitFn };
}

describe("KbPageVisitsService.getBacklinks — BE-24 / BE-25 cursor pagination", () => {
  beforeEach(() => {
    authMock.visiblePagePredicate.mockClear();
    authMock.assertPageAccess.mockClear();
  });

  it("returns a CursorPage shape not a plain array", async () => {
    const { db } = makeBacklinksDb(0);
    const svc = new KbPageVisitsService(db, authMock as never);

    const result = await svc.getBacklinks(makeUser(), 1);

    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("pagination");
    expect(Array.isArray((result as { data: unknown }).data)).toBe(true);
  });

  it("hasMore is true when links exceed the limit", async () => {
    const { db } = makeBacklinksDb(51);
    const svc = new KbPageVisitsService(db, authMock as never);

    const result = await svc.getBacklinks(makeUser(), 1);

    expect((result as { pagination: { hasMore: boolean } }).pagination.hasMore).toBe(true);
  });

  it("hasMore is false when links fit within the limit (positive control)", async () => {
    const { db } = makeBacklinksDb(10);
    const svc = new KbPageVisitsService(db, authMock as never);

    const result = await svc.getBacklinks(makeUser(), 1);

    expect((result as { pagination: { hasMore: boolean } }).pagination.hasMore).toBe(false);
  });

  it("fetches limit+1 links so the sentinel technique can compute hasMore without a count query", async () => {
    const { db, linkLimitFn } = makeBacklinksDb(0);
    const svc = new KbPageVisitsService(db, authMock as never);

    await svc.getBacklinks(makeUser(), 1);

    expect(linkLimitFn).toHaveBeenCalledWith(51);
  });

  it("no longer calls .limit(200) which was twice the cap", async () => {
    const { db, linkLimitFn } = makeBacklinksDb(0);
    const svc = new KbPageVisitsService(db, authMock as never);

    await svc.getBacklinks(makeUser(), 1);

    expect(linkLimitFn).not.toHaveBeenCalledWith(200);
  });

  it("clamps an over-cap limit to PAGE_SIZE_CAP", async () => {
    const { db, linkLimitFn } = makeBacklinksDb(0);
    const svc = new KbPageVisitsService(db, authMock as never);

    await svc.getBacklinks(makeUser(), 1, undefined, PAGE_SIZE_CAP + 50);

    expect(linkLimitFn).toHaveBeenCalledWith(PAGE_SIZE_CAP + 1);
  });
});
