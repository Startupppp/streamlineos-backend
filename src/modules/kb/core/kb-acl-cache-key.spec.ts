import { KbAccessService } from "./kb-access.service";
import { kbAclCacheKey } from "./kb-acl-cache-key";
import { agentTokenPrincipal, humanSessionPrincipal } from "../../../common/auth/principal";
import type { AccessService } from "../../access/access.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG = "org-kb-acl";
const USER = "user-kb-acl";
const MEMBERSHIP = 7;

const RESTRICTED_SPACE = 1;
const PUBLIC_SPACE = 2;

interface CacheHarness {
  cache: CacheService;
  keys: string[];
}

function makeCache(): CacheHarness {
  const store = new Map<string, unknown>();
  const keys: string[] = [];
  const cache = {
    cachedVersioned: jest
      .fn()
      .mockImplementation(async (ns: string, key: string, fetcher: () => Promise<unknown>) => {
        const composite = `${ns}::${key}`;
        const hit = store.get(composite);
        if (hit !== undefined) return hit;
        keys.push(composite);
        const value = await fetcher();
        store.set(composite, value);
        return value;
      }),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  };
  return { cache: cache as unknown as CacheService, keys };
}

function makeDb() {
  const spaceRows = [
    { id: RESTRICTED_SPACE, audience: "internal" },
    { id: PUBLIC_SPACE, audience: "public" },
  ];
  const memberRows = [{ spaceId: RESTRICTED_SPACE }];

  const chain = (rows: unknown[]) => {
    const node: Record<string, jest.Mock> = {};
    node.from = jest.fn(() => node);
    node.innerJoin = jest.fn(() => node);
    node.where = jest.fn(() => Promise.resolve(rows));
    return node;
  };

  let selectCall = 0;
  let distinctCall = 0;
  return {
    select: jest.fn(() => (selectCall++ === 0 ? chain(spaceRows) : chain([]))),
    selectDistinct: jest.fn(() => {
      const idx = distinctCall++;
      if (idx === 0) return chain([]);
      if (idx === 1) return chain(memberRows);
      return chain([]);
    }),
    query: { kbSpaces: { findFirst: jest.fn().mockResolvedValue(null) } },
    __resetCallCounters: () => {
      selectCall = 0;
      distinctCall = 0;
    },
  };
}

function userWith(principal: CurrentUserContext["principal"]): CurrentUserContext {
  return {
    orgId: ORG,
    userId: USER,
    role: "MEMBER",
    isOrgOwner: false,
    principal,
  } as CurrentUserContext;
}

describe("kbAclCacheKey — the ACL dimension is a required field, not an optional one", () => {
  it("refuses to build a key without a resolved permissions version", () => {
    expect(() =>
      kbAclCacheKey(USER, { orgId: ORG, permissionsVersion: 0, membershipId: MEMBERSHIP }),
    ).toThrow(/permissionsVersion/);
    expect(() =>
      kbAclCacheKey(USER, {
        orgId: ORG,
        permissionsVersion: Number.NaN,
        membershipId: MEMBERSHIP,
      }),
    ).toThrow(/permissionsVersion/);
  });

  it("refuses to build a tenant-blind key, so a shared namespace cannot cross organisations", () => {
    expect(() =>
      kbAclCacheKey(USER, { orgId: "", permissionsVersion: 1, membershipId: MEMBERSHIP }),
    ).toThrow(/orgId/);
  });

  it("produces a different key for every ACL dimension that changes the answer", () => {
    const base = kbAclCacheKey(USER, {
      orgId: ORG,
      permissionsVersion: 1,
      membershipId: MEMBERSHIP,
    });
    expect(base).not.toBe(
      kbAclCacheKey(USER, { orgId: ORG, permissionsVersion: 2, membershipId: MEMBERSHIP }),
    );
    expect(base).not.toBe(
      kbAclCacheKey(USER, { orgId: ORG, permissionsVersion: 1, membershipId: 8 }),
    );
    expect(base).not.toBe(
      kbAclCacheKey("other-user", { orgId: ORG, permissionsVersion: 1, membershipId: MEMBERSHIP }),
    );
    expect(base).not.toBe(
      kbAclCacheKey(USER, { orgId: ORG, permissionsVersion: 1, membershipId: null }),
    );
  });

  it("BITE: the same person in a second organisation gets a different key even under one namespace", () => {
    const inOrgA = kbAclCacheKey(USER, {
      orgId: ORG,
      permissionsVersion: 1,
      membershipId: MEMBERSHIP,
    });
    const inOrgB = kbAclCacheKey(USER, {
      orgId: "org-other",
      permissionsVersion: 1,
      membershipId: MEMBERSHIP,
    });
    expect(inOrgA).not.toBe(inOrgB);
    expect(inOrgA).toContain(ORG);
    expect(inOrgB).toContain("org-other");
  });

  it("is stable for an unchanged ACL dimension, so the cache still caches", () => {
    expect(
      kbAclCacheKey(USER, { orgId: ORG, permissionsVersion: 3, membershipId: MEMBERSHIP }),
    ).toBe(kbAclCacheKey(USER, { orgId: ORG, permissionsVersion: 3, membershipId: MEMBERSHIP }));
  });
});

describe("KbAccessService.getAccessibleSpaceIds — cache key carries the ACL dimension", () => {
  it("BITE: a revoked kb:spaces:manage stops serving the admin-wide space list from cache", async () => {
    const { cache, keys } = makeCache();
    const db = makeDb();
    let permissionsVersion = 1;
    let isAdmin = true;
    const access = {
      holds: jest.fn().mockImplementation(async () => isAdmin),
      getPermissionsVersion: jest.fn().mockImplementation(async () => permissionsVersion),
    } as unknown as AccessService;

    const svc = new KbAccessService(db as never, cache, access);
    const user = userWith(humanSessionPrincipal(MEMBERSHIP, false));

    const asAdmin = await svc.getAccessibleSpaceIds(user);
    expect(asAdmin).toEqual([RESTRICTED_SPACE, PUBLIC_SPACE]);

    isAdmin = false;
    permissionsVersion = 2;
    db.__resetCallCounters();

    const afterRevocation = await svc.getAccessibleSpaceIds(user);
    expect(afterRevocation).toEqual([PUBLIC_SPACE]);
    expect(afterRevocation).not.toContain(RESTRICTED_SPACE);
    expect(keys).toHaveLength(2);
  });

  it("still caches across calls when nothing about the caller's ACL moved", async () => {
    const { cache, keys } = makeCache();
    const db = makeDb();
    const access = {
      holds: jest.fn().mockResolvedValue(true),
      getPermissionsVersion: jest.fn().mockResolvedValue(5),
    } as unknown as AccessService;

    const svc = new KbAccessService(db as never, cache, access);
    const user = userWith(humanSessionPrincipal(MEMBERSHIP, false));

    await svc.getAccessibleSpaceIds(user);
    await svc.getAccessibleSpaceIds(user);

    expect(keys).toHaveLength(1);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("does not let two principals of the same user share one entry when their accountable membership differs", async () => {
    const { cache, keys } = makeCache();
    const db = makeDb();
    const access = {
      holds: jest.fn().mockResolvedValue(true),
      getPermissionsVersion: jest.fn().mockResolvedValue(1),
    } as unknown as AccessService;

    const svc = new KbAccessService(db as never, cache, access);

    await svc.getAccessibleSpaceIds(userWith(humanSessionPrincipal(MEMBERSHIP, false)));
    db.__resetCallCounters();
    await svc.getAccessibleSpaceIds(userWith(agentTokenPrincipal(MEMBERSHIP + 1, 3, [])));

    expect(keys).toHaveLength(2);
  });
});
