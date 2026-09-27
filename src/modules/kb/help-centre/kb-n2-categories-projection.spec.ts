import type { Db } from "../../../db/drizzle.module";
import { KbCategoriesService } from "./kb-categories.service";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";

function buildCategoryChain(rows: unknown[] = []) {
  let limitArg: number | undefined;

  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
  };

  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockImplementation((n: number) => {
    limitArg = n;
    return Promise.resolve(rows);
  });

  const db = { select: jest.fn().mockReturnValue(chain) };
  return { db, chain, getLimitArg: () => limitArg };
}

function makeUser(orgId: string) {
  return { orgId, userId: "user-1", isOwner: false } as never;
}

const access = {
  assertSpaceAccessible: jest.fn().mockResolvedValue(undefined),
} as never;

describe("KbCategoriesService.listBySpace — BE-07 projection / BE-132 bounded read", () => {
  it("passes a column selection object to select() — not bare select() — satisfying BE-07", async () => {
    const { db } = buildCategoryChain();
    const svc = new KbCategoriesService(db as unknown as Db, access);

    await svc.listBySpace(makeUser("org-1"), 5);

    const selectArg = (db.select as jest.Mock).mock.calls[0]?.[0];
    expect(selectArg).toBeDefined();
    expect(typeof selectArg).toBe("object");
    expect(selectArg).not.toBeNull();
    expect(Object.keys(selectArg).length).toBeGreaterThan(0);
  });

  it("applies PAGE_SIZE_CAP as the hard limit — satisfying BE-132 / BE-24", async () => {
    const { db, getLimitArg } = buildCategoryChain();
    const svc = new KbCategoriesService(db as unknown as Db, access);

    await svc.listBySpace(makeUser("org-1"), 5);

    expect(getLimitArg()).toBe(PAGE_SIZE_CAP);
  });

  it("returns an array (shape unchanged for existing callers)", async () => {
    const { db } = buildCategoryChain([{ id: 1, name: "Alpha" }]);
    const svc = new KbCategoriesService(db as unknown as Db, access);

    const result = await svc.listBySpace(makeUser("org-1"), 5);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it("projects isPublished so a caller relying on that field does not receive undefined", async () => {
    const row = {
      id: 10,
      orgId: "org-1",
      spaceId: 5,
      parentId: null,
      name: "Root",
      slug: "root",
      description: null,
      icon: null,
      sortOrder: 0,
      isPublished: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { db } = buildCategoryChain([row]);
    const svc = new KbCategoriesService(db as unknown as Db, access);

    const result = await svc.listBySpace(makeUser("org-1"), 5);

    expect(result[0]?.isPublished).toBe(true);
  });
});
