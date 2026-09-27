import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageCommentsService } from "./kb-page-comments.service";

function makeUser(orgId = "org-1") {
  return {
    orgId,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 1 },
  } as never;
}

type FindFirstMock = jest.Mock;

interface MockDb {
  commentFindFirst: FindFirstMock;
  pageFindFirst: FindFirstMock;
  db: Db;
}

function makeDb(commentRow: unknown, pageRow: unknown): MockDb {
  const commentFindFirst = jest.fn().mockResolvedValue(commentRow);
  const pageFindFirst = jest.fn().mockResolvedValue(pageRow);
  const db = {
    query: {
      kbPageComments: { findFirst: commentFindFirst },
      kbPages: { findFirst: pageFindFirst },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }),
      }),
    }),
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    }),
  } as unknown as Db;
  return { commentFindFirst, pageFindFirst, db };
}

const dispatch = { emit: jest.fn() } as never;
const access = { holds: jest.fn().mockResolvedValue(false) } as never;

function makeAuth(pageVisible: boolean) {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue(undefined),
  };
}

const PAGE_ID = 5;
const COMMENT_ID = 99;
const EXISTING_COMMENT = { id: COMMENT_ID, authorId: "user-1", pageId: PAGE_ID };

describe("KbPageCommentsService.update — enumeration guard", () => {
  const input = { content: "updated" } as never;

  it("throws NotFoundException('Comment not found') when comment does not exist", async () => {
    const { db } = makeDb(null, null);
    const auth = makeAuth(false);
    const svc = new KbPageCommentsService(db, dispatch, access, auth as never);

    const error = await svc.update(makeUser(), COMMENT_ID, input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
  });

  it("throws NotFoundException('Comment not found') when comment exists but page is restricted", async () => {
    const { db } = makeDb(EXISTING_COMMENT, null);
    const auth = makeAuth(false);
    const svc = new KbPageCommentsService(db, dispatch, access, auth as never);

    const error = await svc.update(makeUser(), COMMENT_ID, input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
    expect(auth.visiblePagePredicate).toHaveBeenCalled();
  });

  it("nonexistent and restricted produce identical errors", async () => {
    const input2 = { content: "x" } as never;

    const errorA = await new KbPageCommentsService(
      makeDb(null, null).db,
      dispatch,
      access,
      makeAuth(false) as never,
    ).update(makeUser(), COMMENT_ID, input2).catch((e: unknown) => e);

    const errorB = await new KbPageCommentsService(
      makeDb(EXISTING_COMMENT, null).db,
      dispatch,
      access,
      makeAuth(false) as never,
    ).update(makeUser(), COMMENT_ID, input2).catch((e: unknown) => e);

    expect((errorA as NotFoundException).message).toBe((errorB as NotFoundException).message);
    expect((errorA as NotFoundException).getStatus()).toBe((errorB as NotFoundException).getStatus());
  });
});

describe("KbPageCommentsService.remove — enumeration guard", () => {
  it("throws NotFoundException('Comment not found') when comment does not exist", async () => {
    const { db } = makeDb(null, null);
    const svc = new KbPageCommentsService(db, dispatch, access, makeAuth(false) as never);

    const error = await svc.remove(makeUser(), COMMENT_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
  });

  it("throws NotFoundException('Comment not found') when comment exists but page is restricted", async () => {
    const { db } = makeDb(EXISTING_COMMENT, null);
    const auth = makeAuth(false);
    const svc = new KbPageCommentsService(db, dispatch, access, auth as never);

    const error = await svc.remove(makeUser(), COMMENT_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
    expect(auth.visiblePagePredicate).toHaveBeenCalled();
  });
});

describe("KbPageCommentsService.resolve — enumeration guard", () => {
  it("throws NotFoundException('Comment not found') when comment does not exist", async () => {
    const { db } = makeDb(null, null);
    const svc = new KbPageCommentsService(db, dispatch, access, makeAuth(false) as never);

    const error = await svc.resolve(makeUser(), COMMENT_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
  });

  it("throws NotFoundException('Comment not found') when comment exists but page is restricted", async () => {
    const { db } = makeDb(EXISTING_COMMENT, null);
    const auth = makeAuth(false);
    const svc = new KbPageCommentsService(db, dispatch, access, auth as never);

    const error = await svc.resolve(makeUser(), COMMENT_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
    expect(auth.visiblePagePredicate).toHaveBeenCalled();
  });
});

describe("KbPageCommentsService.list — enumeration guard", () => {
  it("throws NotFoundException('Comment not found') when page is inaccessible, so page existence cannot be probed via listing comments", async () => {
    const { db } = makeDb(null, null);
    const auth = makeAuth(false);
    const svc = new KbPageCommentsService(db, dispatch, access, auth as never);

    const error = await svc.list(makeUser(), PAGE_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
  });

  it("returns a CursorPage when the page is accessible (positive control — the guard fires only for inaccessible pages)", async () => {
    const listChain = {
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      query: { kbPages: { findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID }) } },
      select: jest.fn().mockReturnValue(listChain),
    } as unknown as Db;
    const auth = makeAuth(true);
    const svc = new KbPageCommentsService(db, dispatch, access, auth as never);

    const result = await svc.list(makeUser(), PAGE_ID);

    expect(result).toHaveProperty("data");
    expect(Array.isArray((result as { data: unknown }).data)).toBe(true);
  });
});

describe("KbPageCommentsService.create — enumeration guard", () => {
  it("throws NotFoundException('Comment not found') when page is inaccessible, so page existence cannot be probed via comment creation", async () => {
    const { db } = makeDb(null, null);
    const auth = makeAuth(false);
    const svc = new KbPageCommentsService(db, dispatch, access, auth as never);

    const error = await svc.create(makeUser(), PAGE_ID, { content: "test" } as never).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
  });

  it("passes the page guard when the page exists, so the guard fires only for inaccessible pages (positive control)", async () => {
    const db = {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID, createdById: null, ownerUserId: null }),
        },
      },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as Db;
    const auth = makeAuth(true);
    const svc = new KbPageCommentsService(db, dispatch, access, auth as never);

    const error = await svc.create(makeUser(), PAGE_ID, { content: "test" } as never).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toBe("Failed to create comment");
  });
});
