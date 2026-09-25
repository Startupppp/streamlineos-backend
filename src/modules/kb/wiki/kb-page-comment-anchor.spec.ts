import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageCommentsService } from "./kb-page-comments.service";

describe("KbPageCommentsService.create — anchored comments", () => {
  const ORG = "org-test";
  const PAGE_ID = 5;
  const PARENT_ID = 41;

  function makeUser() {
    return { orgId: ORG, userId: "user-alice", isOrgOwner: true } as never;
  }

  const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
  const access = { holds: jest.fn().mockResolvedValue(false) } as never;

  function makeAuthMock() {
    return {
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
      assertPageAccess: jest
        .fn()
        .mockResolvedValue({ orgId: ORG, pageId: PAGE_ID, action: "comment", via: "admin" }),
    };
  }

  function makeJoinChain(row: Record<string, unknown>) {
    const chain: Record<string, unknown> = {
      where: jest.fn().mockResolvedValue([row]),
    };
    chain.leftJoin = jest.fn().mockReturnValue(chain);
    chain.innerJoin = jest.fn().mockReturnValue(chain);
    return chain;
  }

  function makeInsertedRow(over: Record<string, unknown> = {}) {
    return {
      id: 99,
      orgId: ORG,
      pageId: PAGE_ID,
      authorId: "user-alice",
      parentId: null,
      content: "hello",
      anchorBlockIndex: null,
      anchorQuote: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    };
  }

  it("persists the anchor fields on a top-level comment", async () => {
    const insertedRow = makeInsertedRow({ anchorBlockIndex: 3, anchorQuote: "the quoted text" });
    const valuesFn = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([insertedRow]),
    });
    const db = {
      query: {
        kbPages: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: PAGE_ID, orgId: ORG, createdById: null, ownerUserId: null }),
        },
      },
      select: jest
        .fn()
        .mockReturnValue({ from: jest.fn().mockReturnValue(makeJoinChain({ comment: insertedRow, authorName: "Alice", authorEmail: "a@example.com" })) }),
      insert: jest.fn().mockReturnValue({ values: valuesFn }),
    } as unknown as Db;

    const svc = new KbPageCommentsService(db, dispatch, access, makeAuthMock() as never);
    const result = await svc.create(makeUser(), PAGE_ID, {
      content: "hello",
      parentId: null,
      anchorBlockIndex: 3,
      anchorQuote: "the quoted text",
    });

    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({ anchorBlockIndex: 3, anchorQuote: "the quoted text" }),
    );
    expect(result).toHaveProperty("anchorBlockIndex", 3);
    expect(result).toHaveProperty("anchorQuote", "the quoted text");
  });

  it("writes null anchor fields when no anchor is supplied", async () => {
    const insertedRow = makeInsertedRow();
    const valuesFn = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([insertedRow]),
    });
    const db = {
      query: {
        kbPages: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: PAGE_ID, orgId: ORG, createdById: null, ownerUserId: null }),
        },
      },
      select: jest
        .fn()
        .mockReturnValue({ from: jest.fn().mockReturnValue(makeJoinChain({ comment: insertedRow, authorName: "Alice", authorEmail: "a@example.com" })) }),
      insert: jest.fn().mockReturnValue({ values: valuesFn }),
    } as unknown as Db;

    const svc = new KbPageCommentsService(db, dispatch, access, makeAuthMock() as never);
    await svc.create(makeUser(), PAGE_ID, { content: "hello", parentId: null });

    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({ anchorBlockIndex: null, anchorQuote: null }),
    );
  });

  it("rejects an anchor on a reply because a reply inherits its thread's anchor", async () => {
    const db = {
      query: {
        kbPages: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: PAGE_ID, orgId: ORG, createdById: null, ownerUserId: null }),
        },
        kbPageComments: {
          findFirst: jest.fn().mockResolvedValue({ id: PARENT_ID }),
        },
      },
      insert: jest.fn(),
    } as unknown as Db;

    const svc = new KbPageCommentsService(db, dispatch, access, makeAuthMock() as never);

    await expect(
      svc.create(makeUser(), PAGE_ID, {
        content: "a reply",
        parentId: PARENT_ID,
        anchorBlockIndex: 1,
        anchorQuote: "quoted",
      }),
    ).rejects.toThrow(BadRequestException);
    expect((db as unknown as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
  });

  it("allows a reply with no anchor fields", async () => {
    const insertedRow = makeInsertedRow({ parentId: PARENT_ID });
    const valuesFn = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([insertedRow]),
    });
    const db = {
      query: {
        kbPages: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: PAGE_ID, orgId: ORG, createdById: null, ownerUserId: null }),
        },
        kbPageComments: {
          findFirst: jest.fn().mockResolvedValue({ id: PARENT_ID }),
        },
      },
      select: jest
        .fn()
        .mockReturnValue({ from: jest.fn().mockReturnValue(makeJoinChain({ comment: insertedRow, authorName: "Alice", authorEmail: "a@example.com" })) }),
      insert: jest.fn().mockReturnValue({ values: valuesFn }),
    } as unknown as Db;

    const svc = new KbPageCommentsService(db, dispatch, access, makeAuthMock() as never);
    const result = await svc.create(makeUser(), PAGE_ID, { content: "a reply", parentId: PARENT_ID });

    expect(result).toHaveProperty("parentId", PARENT_ID);
    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({ anchorBlockIndex: null, anchorQuote: null }),
    );
  });
});
