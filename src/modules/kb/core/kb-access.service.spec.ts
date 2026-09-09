import { KbAccessService } from "./kb-access.service";
import type { AccessService } from "../../access/access.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeUser(over: Partial<CurrentUserContext>): CurrentUserContext {
  return {
    userId: "u1",
    orgId: "o1",
    role: "member",
    isOrgOwner: false,
    enabledModules: ["kb"],
    ...over,
  } as unknown as CurrentUserContext;
}

describe("KbAccessService.getAccessibleSpaceIds — deny by default", () => {
  function makeService(
    spaces: { id: number; audience: string }[],
    grantedSpaceIds: number[],
  ): KbAccessService {
    const selectResults: unknown[][] = [spaces, []];
    const makeChain = (result: unknown[]) => {
      const chain: Record<string, jest.Mock> = {};
      chain.from = jest.fn(() => chain);
      chain.innerJoin = jest.fn(() => chain);
      chain.where = jest.fn(() => Promise.resolve(result));
      return chain;
    };
    const db = {
      select: jest.fn(() => makeChain(selectResults.shift() ?? [])),
      selectDistinct: jest.fn(() =>
        makeChain(grantedSpaceIds.map((spaceId) => ({ spaceId }))),
      ),
    };
    const access = {
      holds: jest.fn().mockResolvedValue(false),
      getPermissionsVersion: jest.fn().mockResolvedValue(1),
    } as unknown as AccessService;
    const cache = {
      cachedVersioned: jest.fn().mockImplementation(
        (_ns: unknown, _key: unknown, fn: () => unknown) => fn(),
      ),
    } as unknown as CacheService;
    return new KbAccessService(db as never, cache, access);
  }

  const member = makeUser({
    orgId: "org-acl",
    userId: "u-acl",
    principal: { kind: "human-session", membershipId: 99, isOrgOwner: false },
  } as Partial<CurrentUserContext>);

  it("a member-less internal space is NOT accessible — emptiness is not permission", async () => {
    const svc = makeService([{ id: 1, audience: "internal" }], []);

    expect(await svc.getAccessibleSpaceIds(member)).toEqual([]);
  });

  it("BITE: the same space IS accessible once the caller is a member", async () => {
    const svc = makeService([{ id: 1, audience: "internal" }], [1]);

    expect(await svc.getAccessibleSpaceIds(member)).toEqual([1]);
  });

  it("public and mixed audiences stay open without membership", async () => {
    const svc = makeService(
      [
        { id: 1, audience: "internal" },
        { id: 2, audience: "public" },
        { id: 3, audience: "mixed" },
      ],
      [],
    );

    expect(await svc.getAccessibleSpaceIds(member)).toEqual([2, 3]);
  });
});

describe("KbAccessService.isAdmin", () => {
  function makeService(holdsResult: boolean): KbAccessService {
    const db = {} as never;
    const cache = {} as CacheService;
    const access = { holds: jest.fn().mockResolvedValue(holdsResult) } as unknown as AccessService;
    return new KbAccessService(db, cache, access);
  }

  it("returns true when the seam grants kb:spaces:manage", async () => {
    expect(await makeService(true).isAdmin(makeUser({}))).toBe(true);
  });

  it("returns false when the seam denies kb:spaces:manage", async () => {
    expect(await makeService(false).isAdmin(makeUser({}))).toBe(false);
  });

  it("is true for an org owner who holds nothing explicitly — seam is sole authority", async () => {
    expect(
      await makeService(true).isAdmin(makeUser({ isOrgOwner: true })),
    ).toBe(true);
  });
});
