jest.mock("../../common/relocation/relocation-traffic-tracker", () => ({
  refreshRelocationTargets: jest.fn().mockResolvedValue(undefined),
  isRelocationTarget: jest.fn().mockReturnValue(false),
}));

import { AccessService } from "./access.service";
import { AccessVersionCache } from "./access-version-cache";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import type { EntitlementsService } from "./entitlements.service";
import type { AccessSnapshot } from "./access.types";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { makeMfaPolicyStub } from "../../../test/helpers/mfa-policy-stub";

const FIXED_SNAPSHOT: AccessSnapshot = {
  scopes: { "home:dashboard:view": "own" },
  modules: {},
  isOrgOwner: false,
  canManageOrganizationMembership: false,
  mfa: { enforced: false, satisfied: true },
  version: 1,
};

const ORG_ID = "org-snapshot-cache";
const USER_ID = "user-snapshot-cache";

function makeContext(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: USER_ID,
    orgId: ORG_ID,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-sc",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
    ...overrides,
  };
}

function buildService() {
  const snapshotStore = new Map<string, unknown>();

  const db = {
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    query: {
      accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    }),
  };

  const cache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    cachedForOrg: jest.fn().mockImplementation(
      async (_o: string, _k: string, fn: () => Promise<unknown>) => fn(),
    ),
    cachedForOrgWith: jest.fn().mockImplementation(
      async (orgId: string, localKey: string, fetcher: () => Promise<unknown>) => {
        const key = `${orgId}:${localKey}`;
        if (snapshotStore.has(key)) return snapshotStore.get(key);
        const result = await fetcher();
        snapshotStore.set(key, result);
        return result;
      },
    ),
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateForOrg: jest.fn().mockResolvedValue(undefined),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  };

  const entitlements = {
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    isCoreModule: jest.fn().mockReturnValue(false),
    getModuleMap: jest.fn().mockResolvedValue({}),
    getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
    buildModuleAvailabilityResolver: jest.fn().mockReturnValue(jest.fn()),
    getPlanLockedModules: jest.fn().mockResolvedValue([]),
  };

  const versionCacheSvc = new AccessVersionCache(
    db as unknown as Db,
    cache as unknown as CacheService,
  );
  const svc = new AccessService(
    db as unknown as Db,
    cache as unknown as CacheService,
    entitlements as unknown as EntitlementsService,
    makeMfaPolicyStub(),
    versionCacheSvc,
  );

  (versionCacheSvc as unknown as Record<string, unknown>)["versionCache"].set(ORG_ID, { version: 1, expiresAt: Date.now() + 60_000 });

  const computeSpy = jest
    .spyOn(svc["snapshotResolver"], "computeAccessSnapshot")
    .mockResolvedValue(FIXED_SNAPSHOT);

  return { svc, db, cache, computeSpy, snapshotStore };
}

describe("AccessService.getAccessSnapshot — snapshot Redis cache", () => {
  it("serves the cached snapshot on the second call without opening a tenant transaction", async () => {
    const { svc, db, computeSpy } = buildService();
    const ctx = makeContext();

    const first = await svc.getAccessSnapshot(ORG_ID, USER_ID, ctx);
    expect(computeSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(FIXED_SNAPSHOT);

    db.transaction.mockClear();
    computeSpy.mockClear();

    const second = await svc.getAccessSnapshot(ORG_ID, USER_ID, ctx);
    expect(computeSpy).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(second).toEqual(FIXED_SNAPSHOT);
  });

  it("recomputes after a permissions version bump (old key is never read again)", async () => {
    const { svc, computeSpy } = buildService();
    const ctx = makeContext();

    await svc.getAccessSnapshot(ORG_ID, USER_ID, ctx);
    expect(computeSpy).toHaveBeenCalledTimes(1);

    (svc["accessVersionCache"] as unknown as Record<string, unknown>)["versionCache"].set(ORG_ID, { version: 2, expiresAt: Date.now() + 60_000 });

    await svc.getAccessSnapshot(ORG_ID, USER_ID, ctx);
    expect(computeSpy).toHaveBeenCalledTimes(2);
  });

  it("never caches a token-scoped request — every call recomputes", async () => {
    const { svc, computeSpy } = buildService();
    const ctx = makeContext({ tokenScopes: ["home:dashboard:view"] });

    await svc.getAccessSnapshot(ORG_ID, USER_ID, ctx);
    expect(computeSpy).toHaveBeenCalledTimes(1);

    await svc.getAccessSnapshot(ORG_ID, USER_ID, ctx);
    expect(computeSpy).toHaveBeenCalledTimes(2);
  });
});
