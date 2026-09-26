import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageTreeService } from "./kb-page-tree.service";
import { KB_PAGE_TREE_PAGE_SIZE } from "./dto/kb-page-tree.dto";

function makeUser(orgId: string) {
  return { orgId, userId: "user-1", isOrgOwner: false } as never;
}

const audit = {} as never;
const makeAuth = () => ({
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn(),
});

describe("KbPageTreeService — acceptance at scale", () => {
  it("root render issues a bounded number of rows regardless of tenant size", async () => {
    const TENANT_SIZE = 100_000;
    const limitsApplied: number[] = [];
    let queryCount = 0;

    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => {
            queryCount++;
            return Object.assign(Promise.resolve([]), {
              orderBy: jest.fn().mockReturnValue(
                Object.assign(Promise.resolve([]), {
                  limit: jest.fn().mockImplementation((n: number) => {
                    limitsApplied.push(n);
                    return Promise.resolve([]);
                  }),
                }),
              ),
            });
          }),
        }),
      })),
    } as unknown as Db;

    const svc = new KbPageTreeService(db, audit, makeAuth() as never, {} as never, { assertSpaceAccessible: jest.fn().mockResolvedValue(undefined) } as never);

    await svc.getTreeLevel(makeUser("org-large"), { limit: KB_PAGE_TREE_PAGE_SIZE });

    expect(limitsApplied.length).toBeGreaterThan(0);
    const maxLimit = Math.max(...limitsApplied);
    expect(maxLimit).toBeLessThanOrEqual(KB_PAGE_TREE_PAGE_SIZE + 1);
    expect(maxLimit).toBeLessThan(TENANT_SIZE);
  });

  it("response size is not a function of tenant size — limit+1 is always the bound", async () => {
    const customLimit = 10;
    const limitsApplied: number[] = [];

    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => {
            return Object.assign(Promise.resolve([]), {
              orderBy: jest.fn().mockReturnValue(
                Object.assign(Promise.resolve([]), {
                  limit: jest.fn().mockImplementation((n: number) => {
                    limitsApplied.push(n);
                    return Promise.resolve([]);
                  }),
                }),
              ),
            });
          }),
        }),
      })),
    } as unknown as Db;

    const svc = new KbPageTreeService(db, audit, makeAuth() as never, {} as never, { assertSpaceAccessible: jest.fn().mockResolvedValue(undefined) } as never);

    await svc.getTreeLevel(makeUser("org-bounded"), { limit: customLimit });

    expect(limitsApplied.filter(n => n === customLimit + 1)).toHaveLength(1);
  });

  it("KB_PAGE_TREE_PAGE_SIZE constant is exported and less than PAGE_SIZE_CAP (100)", () => {
    expect(KB_PAGE_TREE_PAGE_SIZE).toBeDefined();
    expect(KB_PAGE_TREE_PAGE_SIZE).toBeGreaterThan(0);
    expect(KB_PAGE_TREE_PAGE_SIZE).toBeLessThan(100);
  });
});
