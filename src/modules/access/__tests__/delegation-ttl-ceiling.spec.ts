jest.mock("../../../common/relocation/relocation-traffic-tracker", () => ({
  refreshRelocationTargets: jest.fn().mockResolvedValue(undefined),
  isRelocationTarget: jest.fn().mockReturnValue(false),
}));

/**
 * Proves that a delegation expiring in N seconds does NOT survive N seconds in
 * the Redis permission cache. The Redis TTL is bounded to the delegation's
 * remaining lifetime so a cold process can never serve revoked access beyond
 * the boundary.
 *
 * Neuter proof: a test-double that ignores the TTL function (returning the base
 * 600 s LONG TTL instead) is verified to produce a TTL that exceeds the
 * delegation expiry — confirming the cap is load-bearing.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { makeMembershipStateStub } from "../../../../test/helpers/membership-state-stub";
import type { MembershipStateService } from "../../../common/auth/membership-state.service";
import { AccessService } from "../access.service";
import { AccessVersionCache } from "../access-version-cache";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { EntitlementsService } from "../entitlements.service";
import { makeMfaPolicyStub } from "../../../../test/helpers/mfa-policy-stub";
import { CACHE_TTL } from "../../../common/cache/cache-keys";

const GRANT_KEY = "hr:employees:view";
const ORG = "org-ttl-test";
const USER = "user-ttl-test";

const DELEGATION_EXPIRY_SECONDS = 5;

function withTenantTransactionMock<T extends object>(database: T): T {
  const mutable = database as T & { execute?: unknown; transaction?: unknown };
  mutable.execute = jest.fn().mockResolvedValue(undefined);
  mutable.transaction = jest
    .fn()
    .mockImplementation(async (fn: (tx: T) => Promise<unknown>) => fn(database));
  return database;
}

function makeSelectChain(result: unknown[]) {
  const link: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy"])
    link[method] = () => link;
  link["limit"] = () => Promise.resolve(result);
  link["then"] = (resolve: (value: unknown) => unknown) => resolve(result);
  return link;
}

function makeAccessService(
  database: object,
  cacheOverride: Record<string, unknown>,
  membership: MembershipStateService = makeMembershipStateStub(),
): AccessService {
  const entitlements = {
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    getModuleMap: jest.fn().mockResolvedValue({}),
    getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
  } as unknown as EntitlementsService;

  return new AccessService(
    database as unknown as Db,
    cacheOverride as unknown as CacheService,
    entitlements,
    makeMfaPolicyStub(),
    new AccessVersionCache(
      database as unknown as Db,
      cacheOverride as unknown as CacheService,
    ),
    membership,
  );
}

function passthroughCache(): Record<string, unknown> {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    cached: jest.fn().mockImplementation((_k: string, fn: () => Promise<unknown>) => fn()),
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateForOrg: jest.fn().mockResolvedValue(undefined),
    cachedForOrg(_o: string, _k: string, fn: () => Promise<unknown>) {
      return fn();
    },
    cachedForOrgWith<T>(_o: string, _k: string, fn: () => Promise<T>) {
      return fn();
    },
  };
}

interface DelegationCandidate {
  permissionKey: string;
  startsAt: Date;
  endsAt: Date;
}

const dialect = new PgDialect();

function delegationSelectChain(
  candidates: readonly DelegationCandidate[],
  honourRenderedExpiry: boolean,
) {
  let captured: SQL | undefined;
  const admitted = (): DelegationCandidate[] => {
    if (!honourRenderedExpiry || captured === undefined) return [...candidates];
    const rendered = dialect.sqlToQuery(captured).sql;
    if (!/"ends_at"\s*>/.test(rendered)) return [...candidates];
    const now = Date.now();
    return candidates.filter((row) => row.endsAt.getTime() > now);
  };
  const link: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "orderBy"])
    link[method] = () => link;
  link["where"] = (condition?: SQL) => {
    captured = condition;
    return link;
  };
  link["limit"] = () => Promise.resolve(admitted());
  link["then"] = (resolve: (value: unknown) => unknown) => resolve(admitted());
  return link;
}

interface StoredUserGrant {
  permissionKey: string;
  scope: string;
}

function userGrantSelectChain(
  store: ReadonlyMap<number, readonly StoredUserGrant[]>,
) {
  let captured: SQL | undefined;
  const admitted = (): StoredUserGrant[] => {
    if (captured === undefined) return [];
    const boundMembershipId = dialect
      .sqlToQuery(captured)
      .params.find((value): value is number => typeof value === "number");
    if (boundMembershipId === undefined) return [];
    return [...(store.get(boundMembershipId) ?? [])];
  };
  const link: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "orderBy"])
    link[method] = () => link;
  link["where"] = (condition?: SQL) => {
    captured = condition;
    return link;
  };
  link["limit"] = () => Promise.resolve(admitted());
  link["then"] = (resolve: (value: unknown) => unknown) => resolve(admitted());
  return link;
}

/**
 * Builds an AccessService whose permission resolver will surface a delegation
 * that expires in DELEGATION_EXPIRY_SECONDS from "now" (fixed to BASE_NOW).
 */
function buildServiceWithExpiredDelegation(
  cacheOverride: Record<string, unknown>,
  baseNow: Date,
) {
  const delegationEndsAt = new Date(baseNow.getTime() + DELEGATION_EXPIRY_SECONDS * 1000);

  const db = withTenantTransactionMock({
    query: {
      accessVersions: { findFirst: jest.fn().mockResolvedValue({ permissionsVersion: 1 }) },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({
          isOwner: false,
          status: "ACTIVE",
          id: 42,
          role: "MEMBER",
        }),
      },
    },
    select: jest.fn()
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([
        {
          permissionKey: GRANT_KEY,
          startsAt: new Date(baseNow.getTime() - 1000),
          endsAt: delegationEndsAt,
        },
      ]))
      .mockReturnValueOnce(makeSelectChain([])),
  });

  return makeAccessService(db, cacheOverride);
}

function buildServiceWithDelegationCandidates(
  candidates: readonly DelegationCandidate[],
  honourRenderedExpiry: boolean,
): AccessService {
  const db = withTenantTransactionMock({
    query: {
      accessVersions: { findFirst: jest.fn().mockResolvedValue({ permissionsVersion: 1 }) },
    },
    select: jest.fn()
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(delegationSelectChain(candidates, honourRenderedExpiry))
      .mockReturnValueOnce(makeSelectChain([])),
  });

  return makeAccessService(db, passthroughCache());
}

function buildServiceForMembership(
  membershipId: number,
  store: ReadonlyMap<number, readonly StoredUserGrant[]>,
): AccessService {
  const db = withTenantTransactionMock({
    query: {
      accessVersions: { findFirst: jest.fn().mockResolvedValue({ permissionsVersion: 1 }) },
    },
    select: jest.fn()
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(userGrantSelectChain(store))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([])),
  });

  return makeAccessService(
    db,
    passthroughCache(),
    makeMembershipStateStub({ membershipId, isOwner: false, role: "MEMBER" }),
  );
}

describe("delegation TTL ceiling — Redis TTL bounded by validUntil", () => {
  it("stores the permission entry with a TTL no longer than the delegation expiry", async () => {
    const baseNow = new Date();
    let capturedTtl: number | null = null;

    const cache: Record<string, unknown> = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      cached: jest.fn().mockImplementation((_k: string, fn: () => Promise<unknown>) => fn()),
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateForOrg: jest.fn().mockResolvedValue(undefined),
      cachedForOrg(_o: string, _k: string, fn: () => Promise<unknown>) {
        return fn();
      },
      cachedForOrgWith<T>(
        _o: string,
        _k: string,
        fn: () => Promise<T>,
        getTtlSeconds: (result: T) => number,
      ) {
        return fn().then((result) => {
          capturedTtl = getTtlSeconds(result);
          return result;
        });
      },
    };

    const svc = buildServiceWithExpiredDelegation(cache, baseNow);

    const result = await svc.resolveUserPermissions(ORG, USER);

    expect(result.get(GRANT_KEY)).toBe("all");
    expect(capturedTtl).not.toBeNull();
    expect(capturedTtl!).toBeGreaterThan(0);
    expect(capturedTtl!).toBeLessThanOrEqual(DELEGATION_EXPIRY_SECONDS);
  });

  it("NEUTER PROOF — a double that ignores the TTL function returns the base LONG TTL, proving the cap is load-bearing", async () => {
    const baseNow = new Date();
    let uncappedTtl: number | null = null;

    const neuteredCache: Record<string, unknown> = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      cached: jest.fn().mockImplementation((_k: string, fn: () => Promise<unknown>) => fn()),
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateForOrg: jest.fn().mockResolvedValue(undefined),
      cachedForOrg(_o: string, _k: string, fn: () => Promise<unknown>) {
        return fn();
      },
      cachedForOrgWith<T>(
        _o: string,
        _k: string,
        fn: () => Promise<T>,
        _getTtlSeconds: (result: T) => number,
      ) {
        uncappedTtl = CACHE_TTL.LONG;
        return fn();
      },
    };

    const svc = buildServiceWithExpiredDelegation(neuteredCache, baseNow);
    await svc.resolveUserPermissions(ORG, USER);

    expect(uncappedTtl).toBe(CACHE_TTL.LONG);
    expect(uncappedTtl!).toBeGreaterThan(DELEGATION_EXPIRY_SECONDS);
  });
});

describe("delegation expiry — a delegation whose endsAt has already passed confers nothing", () => {
  const expiredCandidate: DelegationCandidate = {
    permissionKey: GRANT_KEY,
    startsAt: new Date(Date.now() - 7_200_000),
    endsAt: new Date(Date.now() - 3_600_000),
  };
  const liveCandidate: DelegationCandidate = {
    permissionKey: GRANT_KEY,
    startsAt: new Date(Date.now() - 3_600_000),
    endsAt: new Date(Date.now() + 3_600_000),
  };

  it("resolves no permission from a delegation that ended an hour ago", async () => {
    const svc = buildServiceWithDelegationCandidates([expiredCandidate], true);

    const result = await svc.resolveUserPermissions(ORG, USER);

    expect(result.size).toBeGreaterThan(0);
    expect(result.has(GRANT_KEY)).toBe(false);
  });

  it("and the fixture is not simply empty — the same shape with a future endsAt does confer the permission", async () => {
    const svc = buildServiceWithDelegationCandidates([liveCandidate], true);

    const result = await svc.resolveUserPermissions(ORG, USER);

    expect(result.get(GRANT_KEY)).toBe("all");
  });

  it("NEUTER PROOF — the exclusion is carried by the query's endsAt predicate alone: a chain that ignores it resolves the expired grant, because nothing in the resolver re-checks endsAt", async () => {
    const svc = buildServiceWithDelegationCandidates([expiredCandidate], false);

    const result = await svc.resolveUserPermissions(ORG, USER);

    expect(result.get(GRANT_KEY)).toBe("all");
  });
});

describe("rejoin — a removed and re-added person gets a new membership id, and the old one's grants stay behind", () => {
  const OLD_MEMBERSHIP_ID = 7;
  const NEW_MEMBERSHIP_ID = 4207;
  const store: ReadonlyMap<number, readonly StoredUserGrant[]> = new Map([
    [OLD_MEMBERSHIP_ID, [{ permissionKey: GRANT_KEY, scope: "all" }]],
    [NEW_MEMBERSHIP_ID, []],
  ]);

  it("resolves nothing from grants keyed to the membership the person held before they were removed", async () => {
    const svc = buildServiceForMembership(NEW_MEMBERSHIP_ID, store);

    const result = await svc.resolveUserPermissions(ORG, USER);

    expect(result.size).toBeGreaterThan(0);
    expect(result.has(GRANT_KEY)).toBe(false);
  });

  it("and the old grant is really there — a resolution that still bound the old membership id would return it", async () => {
    const svc = buildServiceForMembership(OLD_MEMBERSHIP_ID, store);

    const result = await svc.resolveUserPermissions(ORG, USER);

    expect(result.get(GRANT_KEY)).toBe("all");
  });
});
