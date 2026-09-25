import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbCommentsService } from "./kb-comments.service";

function makeUser(orgId = "org-1") {
  return { orgId, userId: "user-1", isOrgOwner: false } as never;
}

interface MockDb {
  commentFindFirst: jest.Mock;
  db: Db;
}

const ARTICLE_ID = 3;
const COMMENT_ID = 77;

const EXISTING_COMMENT = { id: COMMENT_ID, authorId: "user-1", articleId: ARTICLE_ID };

function makeDb(commentRow: unknown): MockDb {
  const commentFindFirst = jest.fn().mockResolvedValue(commentRow);
  const db = {
    query: {
      kbPageComments: { findFirst: jest.fn() },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(commentRow ? [EXISTING_COMMENT] : []),
          }),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }),
      }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
  } as unknown as Db;
  return { commentFindFirst, db };
}

function makeKbAccess(articleAccessible: boolean) {
  if (articleAccessible) {
    return {
      assertArticleViewable: jest.fn().mockResolvedValue(undefined),
      assertArticleEditable: jest.fn().mockResolvedValue({ id: ARTICLE_ID, orgId: "org-1", spaceId: null }),
    };
  }
  return {
    assertArticleViewable: jest.fn().mockRejectedValue(new NotFoundException("Article not found")),
    assertArticleEditable: jest.fn().mockRejectedValue(new NotFoundException("Article not found")),
  };
}

const access = { holds: jest.fn().mockResolvedValue(false) } as never;

describe("KbCommentsService.update — enumeration guard", () => {
  const input = { content: "changed" } as never;

  it("throws NotFoundException('Comment not found') when comment does not exist", async () => {
    const { db } = makeDb(null);
    const svc = new KbCommentsService(db, makeKbAccess(true) as never, access);

    const error = await svc.update(makeUser(), COMMENT_ID, input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
  });

  it("throws NotFoundException('Comment not found') when comment exists but article is restricted", async () => {
    const { db } = makeDb(EXISTING_COMMENT);
    const kbAccess = makeKbAccess(false);
    const svc = new KbCommentsService(db, kbAccess as never, access);

    const error = await svc.update(makeUser(), COMMENT_ID, input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
    expect(kbAccess.assertArticleViewable).toHaveBeenCalled();
  });

  it("nonexistent and restricted produce identical errors", async () => {
    const input2 = { content: "x" } as never;

    const errorA = await new KbCommentsService(
      makeDb(null).db,
      makeKbAccess(true) as never,
      access,
    ).update(makeUser(), COMMENT_ID, input2).catch((e: unknown) => e);

    const errorB = await new KbCommentsService(
      makeDb(EXISTING_COMMENT).db,
      makeKbAccess(false) as never,
      access,
    ).update(makeUser(), COMMENT_ID, input2).catch((e: unknown) => e);

    expect((errorA as NotFoundException).message).toBe((errorB as NotFoundException).message);
    expect((errorA as NotFoundException).getStatus()).toBe((errorB as NotFoundException).getStatus());
  });
});

describe("KbCommentsService.remove — enumeration guard", () => {
  it("throws NotFoundException('Comment not found') when comment does not exist", async () => {
    const { db } = makeDb(null);
    const svc = new KbCommentsService(db, makeKbAccess(true) as never, access);

    const error = await svc.remove(makeUser(), COMMENT_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
  });

  it("throws NotFoundException('Comment not found') when comment exists but article is restricted", async () => {
    const { db } = makeDb(EXISTING_COMMENT);
    const kbAccess = makeKbAccess(false);
    const svc = new KbCommentsService(db, kbAccess as never, access);

    const error = await svc.remove(makeUser(), COMMENT_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
    expect(kbAccess.assertArticleViewable).toHaveBeenCalled();
  });
});

describe("KbCommentsService.resolve — enumeration guard", () => {
  it("throws NotFoundException('Comment not found') when comment does not exist", async () => {
    const { db } = makeDb(null);
    const svc = new KbCommentsService(db, makeKbAccess(true) as never, access);

    const error = await svc.resolve(makeUser(), COMMENT_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
  });

  it("throws NotFoundException('Comment not found') when comment exists but article is restricted", async () => {
    const { db } = makeDb(EXISTING_COMMENT);
    const kbAccess = makeKbAccess(false);
    const svc = new KbCommentsService(db, kbAccess as never, access);

    const error = await svc.resolve(makeUser(), COMMENT_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Comment not found");
    expect(kbAccess.assertArticleEditable).toHaveBeenCalled();
  });
});
