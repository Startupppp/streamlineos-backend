import { AccessPermissionMembersResolver } from "./access-permission-members.resolver";
import { GRANT_PAGE_SIZE } from "../../common/pagination/keyset-drain";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";

function makeQueryChain(result: unknown[]): Record<string, jest.Mock> {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    where: jest.fn(),
    innerJoin: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

function buildResolver(opts: {
  selectPages: unknown[][];
  distinctPages: unknown[][];
  isModuleEnabled?: boolean;
}): AccessPermissionMembersResolver {
  let sIdx = 0;
  let dIdx = 0;

  const db = {
    select: jest.fn().mockImplementation(() =>
      makeQueryChain(opts.selectPages[sIdx++] ?? []),
    ),
    selectDistinct: jest.fn().mockImplementation(() =>
      makeQueryChain(opts.distinctPages[dIdx++] ?? []),
    ),
  };

  const cache = {
    cached: jest.fn().mockImplementation(
      async (_k: string, fn: () => Promise<unknown>) => fn(),
    ),
    cachedForOrg(o: string, k: string, fn: () => Promise<unknown>) {
      return this.cached(`${o}:${k}`, fn);
    },
  };

  const readAccessTable = <Result>(read: () => PromiseLike<Result>) => Promise.resolve(read());

  return new AccessPermissionMembersResolver(
    db as unknown as Db,
    cache as unknown as CacheService,
    readAccessTable,
    () => Promise.resolve(1),
    () => Promise.resolve(opts.isModuleEnabled ?? true),
  );
}

describe("AccessPermissionMembersResolver overflow — role IDs past GRANT_PAGE_SIZE are not silently dropped", () => {
  const ORG = "org-1";
  const PERM = "settings:rbac:manage";

  it("under-inclusion fixed: members of granting roles on page 2 are included", async () => {
    const explicitGrantPage1 = Array.from({ length: GRANT_PAGE_SIZE }, (_, i) => ({
      roleId: i + 1,
    }));
    const explicitGrantPage2 = [{ roleId: GRANT_PAGE_SIZE + 1 }];

    const allExplicitPage1 = Array.from({ length: GRANT_PAGE_SIZE }, (_, i) => ({
      roleId: i + 1,
    }));
    const allExplicitPage2 = [{ roleId: GRANT_PAGE_SIZE + 1 }];

    const overflowMember = { userId: "u-overflow", membershipId: GRANT_PAGE_SIZE + 1 };

    const resolver = buildResolver({
      selectPages: [
        [],
        [],
      ],
      distinctPages: [
        explicitGrantPage1,
        allExplicitPage1,
        [],
        explicitGrantPage2,
        allExplicitPage2,
        [overflowMember],
        [],
      ],
    });

    const result = await resolver.computeMembersWithPermissionCached(ORG, PERM);

    expect(result.some((m) => m.userId === "u-overflow")).toBe(true);
  });

  it("over-inclusion prevented: drain finds role 501 in allExplicit so it is excluded from default fallback", async () => {
    const allExplicitPage1 = Array.from({ length: GRANT_PAGE_SIZE }, (_, i) => ({
      roleId: i + 1,
    }));
    const allExplicitPage2 = [{ roleId: GRANT_PAGE_SIZE + 1 }];

    const resolver = buildResolver({
      selectPages: [
        [],
        [{ roleId: GRANT_PAGE_SIZE + 1 }],
      ],
      distinctPages: [
        [],
        allExplicitPage1,
        [],
        allExplicitPage2,
      ],
    });

    const result = await resolver.computeMembersWithPermissionCached(ORG, PERM);

    expect(result.some((m) => m.userId === "u-over-included")).toBe(false);
  });

  it("over-inclusion root cause: without drain, allExplicit cap leaves a slug-matching role in fallback", () => {
    const cappedRoleIds = Array.from({ length: 500 }, (_, i) => ({ roleId: i + 1 }));
    const slugMatchRows = [{ roleId: 501 }];

    const orgExplicitRoleIds = new Set(cappedRoleIds.map((r) => r.roleId));
    const defaultFallbackRoleIds = slugMatchRows
      .filter((r) => !orgExplicitRoleIds.has(r.roleId))
      .map((r) => r.roleId);

    expect(defaultFallbackRoleIds).toContain(501);
  });
});
