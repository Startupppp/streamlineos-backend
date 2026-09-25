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
