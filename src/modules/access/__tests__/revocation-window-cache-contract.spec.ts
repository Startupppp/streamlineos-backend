import {
  makeMembershipStateStub,
  stateFromRow,
} from "../../../../test/helpers/membership-state-stub";
import { makeMfaPolicyStub } from "../../../../test/helpers/mfa-policy-stub";
import { AccessService } from "../access.service";
import { AccessVersionCache, VERSION_CACHE_TTL_MS } from "../access-version-cache";
import { accessVersionChannel } from "../../../common/rbac/access-version-channel";
import { bumpPermissionsVersion, type DbOrTx } from "../../../common/rbac/access-invalidate";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { EntitlementsService } from "../entitlements.service";

interface Membership {
  isOwner: boolean;
  role: string;
  status: string;
}

function makeDb(durable: { version: number }) {
  const findFirst = jest
    .fn()
    .mockImplementation(() => Promise.resolve({ permissionsVersion: durable.version }));
  const db: Record<string, unknown> = {
    query: { accessVersions: { findFirst } },
    execute: jest.fn().mockResolvedValue(undefined),
  };
  db["transaction"] = jest
    .fn()
    .mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return { db, findFirst };
}

function makeRedisDownCache(staleVersion: number) {
  const redisDown = () => Promise.reject(new Error("redis down"));
  return {
    cached: jest
      .fn()
      .mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    cachedForOrg(o: string, k: string, fn: () => Promise<unknown>, ttl?: number) {
      return this.cached(`${o}:${k}`, fn, ttl);
    },
    get: jest.fn().mockResolvedValue(staleVersion),
    set: jest.fn().mockImplementation(redisDown),
    invalidate: jest.fn().mockImplementation(redisDown),
    invalidateForOrg: jest.fn().mockImplementation(redisDown),
  };
}

function makeInstance(membership: Membership, durable: { version: number }) {
  const { db, findFirst } = makeDb(durable);
  const cache = makeRedisDownCache(durable.version);
  const entitlements = {
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    isCoreModule: jest.fn().mockReturnValue(false),
    getModuleMap: jest.fn().mockResolvedValue({}),
    getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
  };
  const service = new AccessService(
    db as unknown as Db,
    cache as unknown as CacheService,
    entitlements as unknown as EntitlementsService,
    makeMfaPolicyStub(),
    new AccessVersionCache(db as unknown as Db),
    makeMembershipStateStub(() => stateFromRow({ ...membership, id: 1 })),
  );
  return { service, cache, findFirst };
}

function makeVersionTx(durable: { version: number }): DbOrTx {
  const tx = {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => {
          durable.version += 1;
        },
      }),
    }),
  };
  return tx as unknown as DbOrTx;
}

describe("access version revocation fails closed when the shared cache is unreachable", () => {
  afterEach(() => {
    accessVersionChannel.reset();
    jest.restoreAllMocks();
  });

  it("a failed Redis clear does not leave a demoted admin's grant honoured on another instance past the local version TTL", async () => {
    const durable = { version: 7 };
    const membership: Membership = {
      isOwner: false,
      role: ORG_MEMBER_ROLES.ORG_ADMIN,
      status: "ACTIVE",
    };
    const writer = makeInstance(membership, durable);
    const reader = makeInstance(membership, durable);
    writer.service.onModuleInit();

    await expect(
      reader.service.canManageOrganizationMembership("org-1", "user-1"),
    ).resolves.toBe(true);

    membership.role = ORG_MEMBER_ROLES.MEMBER;
    await bumpPermissionsVersion(makeVersionTx(durable), "org-1");

    const clock = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + VERSION_CACHE_TTL_MS + 1);
    const stillAdmin = await reader.service.canManageOrganizationMembership("org-1", "user-1");
    clock.mockRestore();

    expect(stillAdmin).toBe(false);
    expect(reader.cache.get).not.toHaveBeenCalled();
    writer.service.onModuleDestroy();
  });

  it("re-reads the durable row after a local clear instead of any shared cached copy", async () => {
    const durable = { version: 12 };
    const cache = new AccessVersionCache(makeDb(durable).db as unknown as Db);

    await expect(cache.getVersion("org-1")).resolves.toBe(12);
    durable.version = 13;
    cache.clearForOrg("org-1");
    await expect(cache.getVersion("org-1")).resolves.toBe(13);
  });

  it("serves the local version without a DB read inside its TTL and re-reads the DB once it expires", async () => {
    const durable = { version: 3 };
    const { db, findFirst } = makeDb(durable);
    const cache = new AccessVersionCache(db as unknown as Db);

    await expect(cache.getVersion("org-1")).resolves.toBe(3);
    durable.version = 4;
    await expect(cache.getVersion("org-1")).resolves.toBe(3);
    expect(findFirst).toHaveBeenCalledTimes(1);

    const clock = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + VERSION_CACHE_TTL_MS + 1);
    await expect(cache.getVersion("org-1")).resolves.toBe(4);
    clock.mockRestore();
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it("keeps an unchanged admin's grant when no bump happened, even with Redis down", async () => {
    const durable = { version: 7 };
    const membership: Membership = {
      isOwner: false,
      role: ORG_MEMBER_ROLES.ORG_ADMIN,
      status: "ACTIVE",
    };
    const reader = makeInstance(membership, durable);

    await expect(
      reader.service.canManageOrganizationMembership("org-1", "user-1"),
    ).resolves.toBe(true);
    const clock = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + VERSION_CACHE_TTL_MS + 1);
    await expect(
      reader.service.canManageOrganizationMembership("org-1", "user-1"),
    ).resolves.toBe(true);
    clock.mockRestore();
  });
});
