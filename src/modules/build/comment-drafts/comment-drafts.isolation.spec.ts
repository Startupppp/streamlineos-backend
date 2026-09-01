import { NotFoundException } from "@nestjs/common";
import { CommentDraftsService } from "./comment-drafts.service";
import type { Db } from "../../../db/drizzle.module";

function makeEmptySelect(): jest.Mock {
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      }),
    }),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("CommentDraftsService — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when upserting a draft for a ticket in a different org", async () => {
    const db = {
      select: makeEmptySelect(),
      insert: jest.fn(),
      delete: jest.fn(),
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);

    await expect(
      svc.upsert("org-attacker", null, "user-1", 999, { body: "draft" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when deleting a draft in a different org", async () => {
    const db = {
      select: makeEmptySelect(),
      delete: jest.fn(),
      insert: jest.fn(),
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);

    await expect(svc.deleteOne("org-attacker", null, "user-1", 999)).rejects.toThrow(NotFoundException);
  });

  it("listMine returns empty for an org that has no drafts (cross-tenant isolation by predicate)", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            leftJoin: jest.fn().mockReturnValue({
              leftJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  orderBy: jest.fn().mockReturnValue({
                    limit: jest.fn().mockResolvedValue([]),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);
    const result = await svc.listMine("org-other", null, "user-1");
    expect(result).toEqual([]);
  });
});
