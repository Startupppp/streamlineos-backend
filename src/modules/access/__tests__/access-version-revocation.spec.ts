import { AccessService } from "../access.service";
import { AccessVersionCache } from "../access-version-cache";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { EntitlementsService } from "../entitlements.service";
import { accessVersionChannel } from "../../../common/rbac/access-version-channel";
import { subscribeVersionBump } from "../../../common/rbac/access-invalidate";
import { makeMfaPolicyStub } from "../../../../test/helpers/mfa-policy-stub";
import { makeMembershipStateStub } from "../../../../test/helpers/membership-state-stub";
import {
  primeRelocationTrafficTracker,
  resetRelocationTrafficTracker,
  REFRESH_INTERVAL_MS,
} from "../../../common/relocation/relocation-traffic-tracker";

beforeAll(() => {
  primeRelocationTrafficTracker([], Date.now() + REFRESH_INTERVAL_MS * 100);
});

afterAll(() => {
  resetRelocationTrafficTracker();
  accessVersionChannel.reset();
});

afterEach(() => {
  accessVersionChannel.reset();
});

function makeSelectChain(result: unknown[]) {
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    innerJoin: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

function buildVersionService() {
  const db = {
    query: {
      accessVersions: {
        findFirst: jest.fn().mockResolvedValue(undefined),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({
          isOwner: false,
          status: "ACTIVE",
          id: 1,
        }),
      },
      userModuleAccess: {
        findFirst: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([]),
      },
    },
    select: jest.fn().mockReturnValue(makeSelectChain([])),
  } as unknown as Db & {
    query: {
      accessVersions: { findFirst: jest.Mock };
      organizationMembers: { findFirst: jest.Mock };
    };
    select: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  const mutableDb = db as typeof db & { execute: jest.Mock; transaction: jest.Mock };
  mutableDb.execute = jest.fn().mockResolvedValue(undefined);
  mutableDb.transaction = jest.fn().mockImplementation(
    async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
  );

  const cache: CacheService = {
    cached: jest.fn().mockImplementation(
      async (_key: string, fn: () => Promise<unknown>) => fn(),
    ),
    cachedForOrg(o: string, k: string, fn: () => Promise<unknown>) {
      return (this as { cached: jest.Mock }).cached(`${o}:${k}`, fn);
    },
    cachedForOrgWith<T>(o: string, k: string, fn: () => Promise<T>) {
      return (this as { cached: jest.Mock }).cached(`${o}:${k}`, fn);
    },
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateForOrg: jest.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;

  const entitlements: EntitlementsService = {
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    isCoreModule: jest.fn().mockReturnValue(true),
    getModuleMap: jest.fn().mockResolvedValue({}),
    getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
    buildModuleAvailabilityResolver: jest.fn().mockReturnValue({
      resolve: jest.fn().mockResolvedValue({ available: true }),
    }),
    getPlanLockedModules: jest.fn().mockResolvedValue([]),
    getModuleState: jest.fn().mockResolvedValue(true),
  } as unknown as EntitlementsService;

  const typedDb = mutableDb as unknown as Db;
  const svc = new AccessService(
    typedDb,
    cache,
    entitlements,
    makeMfaPolicyStub(),
    new AccessVersionCache(typedDb, cache),
    makeMembershipStateStub({ active: true, isOwner: false, role: "MEMBER", membershipId: 1 }),
  );

  return { svc, db: mutableDb };
}

describe("accessVersionChannel.publish — local listener fires synchronously", () => {
  it("fires all registered listeners before the returned promise resolves", async () => {
    const calls: string[] = [];
    const unsubscribe = subscribeVersionBump((orgId) => {
      calls.push(orgId);
    });

    accessVersionChannel.publish("org-sync-test");
    unsubscribe();

    expect(calls).toEqual(["org-sync-test"]);
  });

  it("does not fire listeners for a different orgId", async () => {
    const calls: string[] = [];
    const unsubscribe = subscribeVersionBump((orgId) => {
      calls.push(orgId);
    });

    accessVersionChannel.publish("org-a");
    accessVersionChannel.publish("org-b");
    unsubscribe();

    expect(calls).toEqual(["org-a", "org-b"]);
  });
});

describe("AccessService.onModuleInit — permsCache cleared on version bump", () => {
  it("makes a fresh DB read after a version bump even within the version-cache TTL window", async () => {
    const { svc, db } = buildVersionService();
    svc.onModuleInit();

    await svc.resolveUserPermissions("org-bump", "user-bump");
    const selectAfterFirst: number = db.select.mock.calls.length;

    accessVersionChannel.publish("org-bump");

    await svc.resolveUserPermissions("org-bump", "user-bump");
    const selectAfterSecond: number = db.select.mock.calls.length;

    expect(selectAfterSecond).toBeGreaterThan(selectAfterFirst);
  });

  it("does not clear cache entries for a different org when the bump fires", async () => {
    const { svc, db } = buildVersionService();
    svc.onModuleInit();

    await svc.resolveUserPermissions("org-unchanged", "user-x");
    const selectAfterFirst: number = db.select.mock.calls.length;

    accessVersionChannel.publish("org-other");

    await svc.resolveUserPermissions("org-unchanged", "user-x");
    const selectAfterSecond: number = db.select.mock.calls.length;

    expect(selectAfterSecond).toBe(selectAfterFirst);
  });

  it("returns empty permissions for an inactive member regardless of cached grant data", async () => {
    const { svc } = buildVersionService();
    svc.onModuleInit();

    const stateReturn = makeMembershipStateStub({
      active: false,
      isOwner: false,
      role: "",
      membershipId: null,
    });
    (svc as unknown as { membershipState: typeof stateReturn }).membershipState = stateReturn;

    const result = await svc.resolveUserPermissions("org-inactive", "user-removed");

    expect(result.size).toBe(0);
  });
});
