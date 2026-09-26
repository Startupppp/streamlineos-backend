import { KbAccessService } from "./kb-access.service";
import { KnowledgeAuthorizationService } from "./authorization/knowledge-authorization.service";
import {
  ABSENT_PRINCIPAL_KIND,
  CEILING_BEARING_PRINCIPAL_KINDS,
  UNBOUNDED_CEILING,
  kbAclCacheKey,
  kbAclDimension,
  kbCeilingDigest,
  kbSpaceScopeIsAdmin,
  type KbAclDimension,
} from "./kb-acl-cache-key";
import { resolvePrincipalScope } from "../../access/access-principal-scope";
import {
  ACCOUNT_ONLY_PRINCIPAL,
  agentTokenPrincipal,
  humanSessionPrincipal,
  personalTokenPrincipal,
  principalCeiling,
  systemJobPrincipal,
  type Principal,
} from "../../../common/auth/principal";
import type { AccessService } from "../../access/access.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG = "org-kb-acl";
const USER = "user-kb-acl";
const MEMBERSHIP = 7;

const RESTRICTED_SPACE = 1;
const PUBLIC_SPACE = 2;

const VIEW_ONLY_CEILING = ["kb:pages:view"];

interface CacheHarness {
  cache: CacheService;
  keys: string[];
}

function makeCache(): CacheHarness {
  const store = new Map<string, unknown>();
  const keys: string[] = [];
  const fill = async (
    ns: string,
    key: string,
    fetcher: () => Promise<unknown>,
  ): Promise<{ value: unknown; cacheOutcome: "hit" | "miss" }> => {
    const composite = `${ns}::${key}`;
    if (store.has(composite)) return { value: store.get(composite), cacheOutcome: "hit" };
    keys.push(composite);
    const value = await fetcher();
    store.set(composite, value);
    return { value, cacheOutcome: "miss" };
  };
  const cache = {
    cachedVersioned: jest
      .fn()
      .mockImplementation(async (ns: string, key: string, fetcher: () => Promise<unknown>) => {
        const { value } = await fill(ns, key, fetcher);
        return value;
      }),
    cachedVersionedWithOutcome: jest
      .fn()
      .mockImplementation((ns: string, key: string, fetcher: () => Promise<unknown>) =>
        fill(ns, key, fetcher),
      ),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  };
  return { cache: cache as unknown as CacheService, keys };
}

interface DbHarness {
  db: unknown;
  selectDistinctCalls: () => number;
}

function makeDb(grantedSpaceIds: number[] = []): DbHarness {
  const spaceRows = [
    { id: RESTRICTED_SPACE, audience: "internal" },
    { id: PUBLIC_SPACE, audience: "public" },
  ];
  const memberRows = grantedSpaceIds.map((spaceId) => ({ spaceId }));

  const chain = (unjoined: unknown[]) => {
    let joined = false;
    const node: Record<string, jest.Mock> = {};
    node.from = jest.fn(() => node);
    node.innerJoin = jest.fn(() => {
      joined = true;
      return node;
    });
    node.where = jest.fn(() => Promise.resolve(joined ? [] : unjoined));
    return node;
  };

  let selectDistinctCalls = 0;
  return {
    db: {
      select: jest.fn(() => chain(spaceRows)),
      selectDistinct: jest.fn(() => {
        selectDistinctCalls += 1;
        return chain(memberRows);
      }),
      query: {
        kbSpaces: { findFirst: jest.fn().mockResolvedValue(null) },
        kbPages: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    },
    selectDistinctCalls: () => selectDistinctCalls,
  };
}

function makeAccess(permissionsVersion = 1): AccessService {
  return {
    getPermissionsVersion: jest.fn().mockResolvedValue(permissionsVersion),
    holds: jest
      .fn()
      .mockImplementation(async (user: CurrentUserContext, permissionKey: string) => {
        const scope = await resolvePrincipalScope(user.principal, permissionKey, async () => "none");
        return scope !== "none";
      }),
  } as unknown as AccessService;
}

function userWith(
  principal: CurrentUserContext["principal"],
  isOrgOwner = false,
): CurrentUserContext {
  return {
    orgId: ORG,
    userId: USER,
    role: isOrgOwner ? "OWNER" : "MEMBER",
    isOrgOwner,
    principal,
  } as CurrentUserContext;
}

const sessionDimension = (over: Partial<KbAclDimension> = {}): KbAclDimension => ({
  orgId: ORG,
  permissionsVersion: 1,
  membershipId: MEMBERSHIP,
  principalKind: "human-session",
  ceilingDigest: UNBOUNDED_CEILING,
  ...over,
});

describe("kbAclCacheKey — the ACL dimension is a required field, not an optional one", () => {
  it("refuses to build a key without a resolved permissions version", () => {
    expect(() => kbAclCacheKey(USER, sessionDimension({ permissionsVersion: 0 }))).toThrow(
      /permissionsVersion/,
    );
    expect(() => kbAclCacheKey(USER, sessionDimension({ permissionsVersion: Number.NaN }))).toThrow(
      /permissionsVersion/,
    );
  });

  it("refuses to build a tenant-blind key, so a shared namespace cannot cross organisations", () => {
    expect(() => kbAclCacheKey(USER, sessionDimension({ orgId: "" }))).toThrow(/orgId/);
  });

  it("refuses to build a key that does not say which kind of principal it belongs to, because an agent token and its issuer's session resolve to the same person", () => {
    expect(() => kbAclCacheKey(USER, sessionDimension({ principalKind: "" }))).toThrow(
      /principalKind/,
    );
  });

  it("refuses to build a key with no ceiling digest, because a token's authority is its ceiling and not its membership record", () => {
    expect(() => kbAclCacheKey(USER, sessionDimension({ ceilingDigest: "" }))).toThrow(
      /ceilingDigest/,
    );
  });

  it("refuses to record a personal token as unbounded, because a ceiling-bearing principal that claims no ceiling would share a key with a full-authority session", () => {
    expect(() =>
      kbAclCacheKey(
        USER,
        sessionDimension({
          principalKind: "personal-token",
          ceilingDigest: UNBOUNDED_CEILING,
        }),
      ),
    ).toThrow(/unbounded/);
  });

  it("names every principal kind that carries a ceiling, so a new ceiling-bearing kind cannot slip past the unbounded guard", () => {
    const principals: Principal[] = [
      humanSessionPrincipal(MEMBERSHIP, false),
      ACCOUNT_ONLY_PRINCIPAL,
      personalTokenPrincipal(MEMBERSHIP, false, "pat-1", VIEW_ONLY_CEILING),
      agentTokenPrincipal(MEMBERSHIP, 3, VIEW_ONLY_CEILING),
      systemJobPrincipal("build-ticket-automation"),
    ];

    for (const principal of principals) {
      const bearsCeiling = principalCeiling(principal) !== null;
      expect(CEILING_BEARING_PRINCIPAL_KINDS.includes(principal.kind)).toBe(bearsCeiling);
    }
  });

  it("produces a different key for every ACL dimension that changes the answer", () => {
    const base = kbAclCacheKey(USER, sessionDimension());
    expect(base).not.toBe(kbAclCacheKey(USER, sessionDimension({ permissionsVersion: 2 })));
    expect(base).not.toBe(kbAclCacheKey(USER, sessionDimension({ membershipId: 8 })));
    expect(base).not.toBe(kbAclCacheKey("other-user", sessionDimension()));
    expect(base).not.toBe(kbAclCacheKey(USER, sessionDimension({ membershipId: null })));
    expect(base).not.toBe(
      kbAclCacheKey(
        USER,
        sessionDimension({
          principalKind: "personal-token",
          ceilingDigest: kbCeilingDigest(VIEW_ONLY_CEILING),
        }),
      ),
    );
    expect(base).not.toBe(
      kbAclCacheKey(
        USER,
        sessionDimension({
          principalKind: "personal-token",
          ceilingDigest: kbCeilingDigest(["kb:spaces:manage"]),
        }),
      ),
    );
  });

  it("BITE: the same person in a second organisation gets a different key even under one namespace", () => {
    const inOrgA = kbAclCacheKey(USER, sessionDimension());
    const inOrgB = kbAclCacheKey(USER, sessionDimension({ orgId: "org-other" }));
    expect(inOrgA).not.toBe(inOrgB);
    expect(inOrgA).toContain(ORG);
    expect(inOrgB).toContain("org-other");
  });

  it("is stable for an unchanged ACL dimension, so the cache still caches", () => {
    expect(kbAclCacheKey(USER, sessionDimension({ permissionsVersion: 3 }))).toBe(
      kbAclCacheKey(USER, sessionDimension({ permissionsVersion: 3 })),
    );
  });

  it("hashes a ceiling independently of the order its keys arrive in, so one authority is one entry", () => {
    expect(kbCeilingDigest(["b:x:y", "a:x:y"])).toBe(kbCeilingDigest(["a:x:y", "b:x:y"]));
    expect(kbCeilingDigest(["a:x:y"])).not.toBe(kbCeilingDigest(["a:x:y", "b:x:y"]));
    expect(kbCeilingDigest(null)).toBe(UNBOUNDED_CEILING);
  });
});

describe("kbAclDimension — one derivation both writers of kb:acc-spaces share", () => {
  it("keys an agent token by no acting membership while keying its issuer's session by the membership, so the two cannot meet", () => {
    const issuer = kbAclDimension(userWith(humanSessionPrincipal(MEMBERSHIP, false)), 1);
    const agent = kbAclDimension(userWith(agentTokenPrincipal(MEMBERSHIP, 3, VIEW_ONLY_CEILING)), 1);

    expect(issuer.membershipId).toBe(MEMBERSHIP);
    expect(agent.membershipId).toBeNull();
    expect(kbAclCacheKey(USER, issuer)).not.toBe(kbAclCacheKey(USER, agent));
  });

  it("falls back to an absent principal kind and an unbounded ceiling when no principal was resolved, so the key still names what it stands for", () => {
    const dimension = kbAclDimension(userWith(undefined), 1);
    expect(dimension.principalKind).toBe(ABSENT_PRINCIPAL_KIND);
    expect(dimension.ceilingDigest).toBe(UNBOUNDED_CEILING);
  });
});

describe("kbSpaceScopeIsAdmin — an owner's membership cannot widen a ceiling-limited principal", () => {
  it("treats an org owner's ordinary session as a KB admin, because an unbounded session wields the whole standing", () => {
    expect(kbSpaceScopeIsAdmin(userWith(humanSessionPrincipal(MEMBERSHIP, true), true), false)).toBe(
      true,
    );
  });

  it("refuses to treat an org owner's narrow-scoped token as a KB admin, because the token was issued with less authority than the person holds", () => {
    const owner = userWith(
      personalTokenPrincipal(MEMBERSHIP, true, "pat-1", VIEW_ONLY_CEILING),
      true,
    );
    expect(kbSpaceScopeIsAdmin(owner, false)).toBe(false);
  });

  it("still admits a token whose ceiling actually carries kb:spaces:manage, so the ceiling decides rather than the principal kind", () => {
    const owner = userWith(
      personalTokenPrincipal(MEMBERSHIP, true, "pat-1", ["kb:spaces:manage"]),
      true,
    );
    expect(kbSpaceScopeIsAdmin(owner, true)).toBe(true);
  });
});

describe("kb:acc-spaces has one owner — both writers key and compute identically", () => {
  function harness(permissionsVersion = 1) {
    const { cache, keys } = makeCache();
    const { db, selectDistinctCalls } = makeDb();
    const access = makeAccess(permissionsVersion);
    return {
      keys,
      selectDistinctCalls,
      kbAccess: new KbAccessService(db as never, cache, access),
      auth: new KnowledgeAuthorizationService(db as never, cache, access),
    };
  }

  it("gives a narrow-scoped owner token its own cache key, because an owner's membership says owner while the token's ceiling says otherwise", async () => {
    const { auth, kbAccess, keys, selectDistinctCalls } = harness();
    const ownerSession = userWith(humanSessionPrincipal(MEMBERSHIP, true), true);
    const ownerToken = userWith(
      personalTokenPrincipal(MEMBERSHIP, true, "pat-1", VIEW_ONLY_CEILING),
      true,
    );

    const session = await auth.resolveStanding(ownerSession);
    expect(session.accessibleSpaceIds).toEqual([RESTRICTED_SPACE, PUBLIC_SPACE]);
    expect(selectDistinctCalls()).toBe(0);

    const token = await kbAccess.getAccessibleSpaceIds(ownerToken);
    expect(token).toEqual([PUBLIC_SPACE]);
    expect(token).not.toContain(RESTRICTED_SPACE);
    expect(selectDistinctCalls()).toBe(1);

    expect(keys).toEqual([
      `kb:acc-spaces:${ORG}::o${ORG}:p1:khuman-session:c${UNBOUNDED_CEILING}:m${MEMBERSHIP}:u${USER}`,
      `kb:acc-spaces:${ORG}::o${ORG}:p1:kpersonal-token:c${kbCeilingDigest(VIEW_ONLY_CEILING)}:m${MEMBERSHIP}:u${USER}`,
    ]);
  });

  it("still serves the same org owner's ordinary session the full space list, so the narrowing above is the token's ceiling and not a resolver that returns nothing", async () => {
    const { kbAccess, keys, selectDistinctCalls } = harness();
    const ownerSession = userWith(humanSessionPrincipal(MEMBERSHIP, true), true);

    expect(await kbAccess.getAccessibleSpaceIds(ownerSession)).toEqual([
      RESTRICTED_SPACE,
      PUBLIC_SPACE,
    ]);
    expect(selectDistinctCalls()).toBe(0);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("khuman-session");
    expect(keys[0]).toContain(`c${UNBOUNDED_CEILING}`);
  });

  it("gives an org owner the same list through either writer, so neither service can fill the other's key with a wider answer", async () => {
    const { auth, kbAccess, keys } = harness();
    const ownerSession = userWith(humanSessionPrincipal(MEMBERSHIP, true), true);

    const throughAuth = await auth.resolveStanding(ownerSession);
    const throughAccess = await kbAccess.getAccessibleSpaceIds(ownerSession);

    expect(throughAccess).toEqual(throughAuth.accessibleSpaceIds);
    expect(keys).toHaveLength(1);
  });

  it("keeps an agent token and the session of the member who issued it in separate entries, because the issuer's space grants are not the agent's", async () => {
    const { auth, kbAccess, keys } = harness();
    const issuerSession = userWith(humanSessionPrincipal(MEMBERSHIP, false));
    const agent = userWith(agentTokenPrincipal(MEMBERSHIP, 3, VIEW_ONLY_CEILING));

    expect(await kbAccess.getAccessibleSpaceIds(issuerSession)).toEqual([PUBLIC_SPACE]);
    expect((await auth.resolveStanding(agent)).accessibleSpaceIds).toEqual([]);

    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain(`khuman-session:c${UNBOUNDED_CEILING}:m${MEMBERSHIP}`);
    expect(keys[1]).toContain(
      `kagent-token:c${kbCeilingDigest(VIEW_ONLY_CEILING)}:mnone`,
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("stops treating a narrow-scoped owner token as an org owner in its standing, so the ceiling reaches the page predicate too", async () => {
    const { auth } = harness();
    const ownerToken = userWith(
      personalTokenPrincipal(MEMBERSHIP, true, "pat-1", VIEW_ONLY_CEILING),
      true,
    );

    const standing = await auth.resolveStanding(ownerToken);

    expect(standing.isOrgOwner).toBe(false);
    expect(standing.isKbAdmin).toBe(false);
    expect(standing.accessibleSpaceIds).not.toContain(RESTRICTED_SPACE);
  });

  it("BITE: a revoked kb:spaces:manage stops serving the admin-wide space list from cache", async () => {
    const { cache, keys } = makeCache();
    const { db } = makeDb();
    let permissionsVersion = 1;
    let isAdmin = true;
    const access = {
      holds: jest.fn().mockImplementation(async () => isAdmin),
      getPermissionsVersion: jest.fn().mockImplementation(async () => permissionsVersion),
    } as unknown as AccessService;

    const svc = new KbAccessService(db as never, cache, access);
    const user = userWith(humanSessionPrincipal(MEMBERSHIP, false));

    expect(await svc.getAccessibleSpaceIds(user)).toEqual([RESTRICTED_SPACE, PUBLIC_SPACE]);

    isAdmin = false;
    permissionsVersion = 2;

    const afterRevocation = await svc.getAccessibleSpaceIds(user);
    expect(afterRevocation).toEqual([PUBLIC_SPACE]);
    expect(afterRevocation).not.toContain(RESTRICTED_SPACE);
    expect(keys).toHaveLength(2);
  });

  it("still caches across calls when nothing about the caller's ACL moved", async () => {
    const { cache, keys } = makeCache();
    const { db } = makeDb();
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

  it("reports the cache outcome from the same entry the plain read fills, so the search path cannot observe a second key", async () => {
    const { cache, keys } = makeCache();
    const { db } = makeDb();
    const access = makeAccess();
    const svc = new KbAccessService(db as never, cache, access);
    const user = userWith(humanSessionPrincipal(MEMBERSHIP, false));

    const first = await svc.getAccessibleSpaceIdsWithCacheOutcome(user);
    const second = await svc.getAccessibleSpaceIdsWithCacheOutcome(user);

    expect(first.cacheOutcome).toBe("miss");
    expect(second.cacheOutcome).toBe("hit");
    expect(await svc.getAccessibleSpaceIds(user)).toEqual(first.spaceIds);
    expect(keys).toHaveLength(1);
  });
});
