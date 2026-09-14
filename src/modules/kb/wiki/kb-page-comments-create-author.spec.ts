import type { Db } from "../../../db/drizzle.module";
import { KbPageCommentsService } from "./kb-page-comments.service";

describe("KbPageCommentsService mutation responses include authorName", () => {
  const ORG = "org-test";
  const PAGE_ID = 5;
  const COMMENT_ID = 99;
  const AUTHOR_NAME = "Alice Smith";

  function makeUser() {
    return { orgId: ORG, userId: "user-alice", isOrgOwner: true } as never;
  }

  const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
  const access = { holds: jest.fn().mockResolvedValue(false) } as never;

  const baseComment = {
    id: COMMENT_ID,
    orgId: ORG,
    pageId: PAGE_ID,
    authorId: "user-alice",
    parentId: null,
    content: "hello",
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function makeJoinChain() {
    const chain: Record<string, unknown> = {
      where: jest.fn().mockResolvedValue([
        { comment: baseComment, authorName: AUTHOR_NAME, authorEmail: "alice@example.com" },
      ]),
    };
    chain.leftJoin = jest.fn().mockReturnValue(chain);
    chain.innerJoin = jest.fn().mockReturnValue(chain);
    return chain;
  }

  it("create — returns authorName in the response", async () => {
    const db = {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({
            id: PAGE_ID,
            orgId: ORG,
            createdById: null,
            ownerUserId: null,
          }),
        },
      },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(makeJoinChain()) }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([baseComment]),
        }),
      }),
    } as unknown as Db;

    const svc = new KbPageCommentsService(db, dispatch, access);
    const result = await svc.create(makeUser(), PAGE_ID, { content: "hello", parentId: null });

    expect(result).toHaveProperty("authorName", AUTHOR_NAME);
  });

  it("update — returns authorName in the response", async () => {
    const db = {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID }),
        },
        kbPageComments: {
          findFirst: jest.fn().mockResolvedValue({ id: COMMENT_ID, authorId: "user-alice", pageId: PAGE_ID }),
        },
      },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(makeJoinChain()) }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([baseComment]),
          }),
        }),
      }),
    } as unknown as Db;

    const svc = new KbPageCommentsService(db, dispatch, access);
    const result = await svc.update(makeUser(), COMMENT_ID, { content: "updated" });

    expect(result).toHaveProperty("authorName", AUTHOR_NAME);
  });

  it("resolve — returns authorName in the response", async () => {
    const db = {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID }),
        },
        kbPageComments: {
          findFirst: jest.fn().mockResolvedValue({ id: COMMENT_ID, pageId: PAGE_ID }),
        },
      },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(makeJoinChain()) }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([baseComment]),
          }),
        }),
      }),
    } as unknown as Db;

    const svc = new KbPageCommentsService(db, dispatch, access);
    const result = await svc.resolve(makeUser(), COMMENT_ID);

    expect(result).toHaveProperty("authorName", AUTHOR_NAME);
  });
});
