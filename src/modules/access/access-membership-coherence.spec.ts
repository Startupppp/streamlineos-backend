import { AccessService } from "./access.service";
import { accessVersionChannel } from "../../common/rbac/access-version-channel";
import { ORG_MEMBER_ROLES } from "../../common/rbac/org-roles";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import type { EntitlementsService } from "./entitlements.service";
import { makeMfaPolicyStub } from "../../../test/helpers/mfa-policy-stub";

/**
 * `canManageOrganizationMembership` reads the membership cache directly, so it
 * has no other invalidation path — unlike permission resolution, which re-reads
 * the member row anyway when the version moves. Instance B is deliberately never
 * subscribed to the local fan-out: subscribing it would clear its caches
 * in-process and mask the defect, which is that nothing reaches an instance that
 * did not perform the write.
 */

interface Membership {
  isOwner: boolean;
  role: string;
  status: string;
}

function makeInstance(
  membership: Membership,
  durable: { version: number },
  shared: Map<string, unknown>,
): AccessService {
  const db: Record<string, unknown> = {
    query: {
      accessVersions: {
        findFirst: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve({ permissionsVersion: durable.version }),
          ),
      },
      organizationMembers: {
        findFirst: jest
          .fn()
          .mockImplementation(() => Promise.resolve({ ...membership })),
      },
    },
    execute: jest.fn().mockResolvedValue(undefined),
  };
  db["transaction"] = jest
    .fn()
    .mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(db));

  const cache = {
    cached: jest
      .fn()
      .mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    invalidate: jest.fn().mockImplementation((key: string) => {
      shared.delete(key);
      return Promise.resolve();
    }),
    cachedForOrg(o: string, k: string, fn: () => Promise<unknown>, ttl?: number) {
      return this.cached(`${o}:${k}`, fn, ttl);
    },
    cachedForOrgWith<T>(_o: string, _k: string, fn: () => Promise<T>) {
      return fn();
    },
    invalidateForOrg: jest.fn().mockResolvedValue(undefined),
    get: jest
      .fn()
      .mockImplementation((key: string) => Promise.resolve(shared.get(key) ?? null)),
    set: jest.fn().mockImplementation((key: string, value: unknown) => {
      shared.set(key, value);
      return Promise.resolve();
    }),
  };

  const entitlements = {
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    isCoreModule: jest.fn().mockReturnValue(false),
    getModuleMap: jest.fn().mockResolvedValue({}),
    getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
  };

  return new AccessService(
    db as unknown as Db,
    cache as unknown as CacheService,
    entitlements as unknown as EntitlementsService,
    makeMfaPolicyStub(),
  );
}

describe("membership authority coherence across instances", () => {
  afterEach(() => {
    accessVersionChannel.reset();
    jest.restoreAllMocks();
  });

  it("stops treating a demoted admin as an admin on the instance that did not perform the write", async () => {
    const shared = new Map<string, unknown>();
    const durable = { version: 7 };
    const membership: Membership = {
      isOwner: false,
      role: ORG_MEMBER_ROLES.ORG_ADMIN,
      status: "ACTIVE",
    };

    const instanceA = makeInstance(membership, durable, shared);
    const instanceB = makeInstance(membership, durable, shared);
    instanceA.onModuleInit();

    await expect(
      instanceA.canManageOrganizationMembership("org-1", "user-1"),
    ).resolves.toBe(true);
    await expect(
      instanceB.canManageOrganizationMembership("org-1", "user-1"),
    ).resolves.toBe(true);

    membership.role = "MEMBER";
    durable.version = 8;
    await accessVersionChannel.publish("org-1");

    const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
    const stillAdminOnB = await instanceB.canManageOrganizationMembership(
      "org-1",
      "user-1",
    );
    clock.mockRestore();

    expect(stillAdminOnB).toBe(false);
    instanceA.onModuleDestroy();
  });

  it("stops honouring a suspended member on the instance that did not perform the write", async () => {
    const shared = new Map<string, unknown>();
    const durable = { version: 7 };
    const membership: Membership = {
      isOwner: false,
      role: ORG_MEMBER_ROLES.ORG_ADMIN,
      status: "ACTIVE",
    };

    const instanceA = makeInstance(membership, durable, shared);
    const instanceB = makeInstance(membership, durable, shared);
    instanceA.onModuleInit();
    await instanceB.canManageOrganizationMembership("org-1", "user-1");

    membership.status = "SUSPENDED";
    durable.version = 8;
    await accessVersionChannel.publish("org-1");

    const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
    const stillAdminOnB = await instanceB.canManageOrganizationMembership(
      "org-1",
      "user-1",
    );
    clock.mockRestore();

    expect(stillAdminOnB).toBe(false);
    instanceA.onModuleDestroy();
  });

  it("serves an unchanged member from cache when no bump happened", async () => {
    const shared = new Map<string, unknown>();
    const durable = { version: 7 };
    const membership: Membership = {
      isOwner: false,
      role: ORG_MEMBER_ROLES.ORG_ADMIN,
      status: "ACTIVE",
    };

    const instance = makeInstance(membership, durable, shared);
    instance.onModuleInit();

    await expect(
      instance.canManageOrganizationMembership("org-1", "user-1"),
    ).resolves.toBe(true);
    await expect(
      instance.canManageOrganizationMembership("org-1", "user-1"),
    ).resolves.toBe(true);

    instance.onModuleDestroy();
  });
});
