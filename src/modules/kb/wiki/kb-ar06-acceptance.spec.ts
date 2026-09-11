import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbPageCommentsService } from "./kb-page-comments.service";
import { KbPageReviewsService, reviewerCanSeeAllReviews } from "./kb-page-reviews.service";
import { KbPageReviewsQueryService } from "./kb-page-reviews-query.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeUser(orgId: string, userId = "user-1"): CurrentUserContext {
  return {
    orgId,
    userId,
    isOrgOwner: false,
    principal: undefined,
  } as never;
}

const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
const audit = { log: jest.fn() } as never;

function makeAccessAllow(): AccessService {
  return { holds: jest.fn().mockResolvedValue(true) } as never;
}

function makeAccessDeny(): AccessService {
  return { holds: jest.fn().mockResolvedValue(false) } as never;
}

function makeSelectJoinChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    where: jest.fn().mockResolvedValue([]),
    orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    limit: jest.fn().mockResolvedValue([]),
  };
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  return chain;
}

function makePageCommentsDb(
  commentRow: { id: number; authorId: string; pageId: number } | null,
  pageRow: { id: number; orgId: string } | null,
): Db {
  return {
    query: {
      kbPageComments: {
        findFirst: jest.fn().mockResolvedValue(commentRow),
      },
      kbPages: {
        findFirst: jest.fn().mockResolvedValue(pageRow),
      },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue(makeSelectJoinChain()),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }),
      }),
    }),
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue([]),
    }),
  } as unknown as Db;
}

describe("AR-06 Criterion 2: page comment access revocation", () => {
  it("update returns NotFoundException when page is no longer accessible (revocation between read and mutation)", async () => {
    const COMMENT_ID = 5;
    const PAGE_ID = 99;
    const ORG = "org-owner";
    const USER = "user-auth";

    const db = makePageCommentsDb(
      { id: COMMENT_ID, authorId: USER, pageId: PAGE_ID },
      null,
    );

    const svc = new KbPageCommentsService(db, dispatch, makeAccessDeny());

    await expect(
      svc.update(makeUser(ORG, USER), COMMENT_ID, { content: "edit" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("remove returns NotFoundException when page is no longer accessible", async () => {
    const COMMENT_ID = 7;
    const PAGE_ID = 100;
    const ORG = "org-owner";
    const USER = "user-auth";

    const db = makePageCommentsDb(
      { id: COMMENT_ID, authorId: USER, pageId: PAGE_ID },
      null,
    );

    const svc = new KbPageCommentsService(db, dispatch, makeAccessDeny());

    await expect(svc.remove(makeUser(ORG, USER), COMMENT_ID)).rejects.toThrow(NotFoundException);
  });

  it("update denies non-author non-admin with ForbiddenException (not NotFoundException)", async () => {
    const COMMENT_ID = 8;
    const PAGE_ID = 101;
    const ORG = "org-owner";
    const AUTHOR = "user-author";
    const OTHER = "user-other";

    const db = makePageCommentsDb(
      { id: COMMENT_ID, authorId: AUTHOR, pageId: PAGE_ID },
      { id: PAGE_ID, orgId: ORG },
    );

    const svc = new KbPageCommentsService(db, dispatch, makeAccessDeny());

    await expect(
      svc.update(makeUser(ORG, OTHER), COMMENT_ID, { content: "hacked" }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe("AR-06 Criterion 3: listDue pagination and scope", () => {
  it("reviewerCanSeeAllReviews is true when seam grants kb:reviews:manage", async () => {
    expect(await reviewerCanSeeAllReviews(makeUser("org"), makeAccessAllow())).toBe(true);
  });

  it("reviewerCanSeeAllReviews is false when seam denies kb:reviews:manage — non-manager gets own-only filter", async () => {
    expect(await reviewerCanSeeAllReviews(makeUser("org"), makeAccessDeny())).toBe(false);
  });

  it("listDue accepts cursor and calls DB with cursor predicate (pagination beyond old 100-row cap)", async () => {
    const ORG = "org-x";
    const dueRow = {
      id: 1,
      orgId: ORG,
      pageId: 10,
      type: "freshness",
      status: "pending",
      requestedById: "user-1",
      reviewerId: null,
      requestedByMembershipId: null,
      reviewerMembershipId: null,
      dueAt: new Date("2026-01-01"),
      decidedAt: null,
      decisionNote: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      pageTitle: "Test",
      requestedByName: null,
      reviewerName: null,
    };

    const limitMock = jest.fn().mockResolvedValue([dueRow]);
    const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock4 = jest.fn().mockReturnValue({ where: whereMock });
    const leftJoinMock3 = jest.fn().mockReturnValue({ leftJoin: leftJoinMock4 });
    const leftJoinMock2 = jest.fn().mockReturnValue({ leftJoin: leftJoinMock3 });
    const leftJoinMock1 = jest.fn().mockReturnValue({ leftJoin: leftJoinMock2 });
    const innerJoinMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock1 });

    const joinChain: Record<string, unknown> = { where: jest.fn().mockResolvedValue([]) };
    joinChain.innerJoin = jest.fn().mockReturnValue(joinChain);
    joinChain.leftJoin = jest.fn().mockReturnValue(joinChain);

    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 10 }),
        },
      },
      select: jest.fn().mockReturnValueOnce({
        from: jest.fn().mockReturnValue(joinChain),
      }).mockReturnValueOnce({
        from: jest.fn().mockReturnValue({ innerJoin: innerJoinMock }),
      }),
    } as unknown as Db;

    const svc = new KbPageReviewsQueryService(db, makeAccessAllow());
    const cursor = { sortValue: new Date("2025-12-31T00:00:00Z"), id: "50" };

    const result = await svc.listDue(makeUser(ORG), cursor);

    expect(Array.isArray(result)).toBe(true);
    expect(limitMock).toHaveBeenCalledWith(50);
    expect(whereMock).toHaveBeenCalled();
  });
});
