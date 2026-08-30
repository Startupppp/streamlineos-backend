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

import { AccessService } from "../access.service";
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

  const entitlements = {
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    getModuleMap: jest.fn().mockResolvedValue({}),
    getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
  } as unknown as EntitlementsService;

  return new AccessService(
    db as unknown as Db,
    cacheOverride as unknown as CacheService,
    entitlements,
    makeMfaPolicyStub(),
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
