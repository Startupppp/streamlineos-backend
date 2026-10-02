import {
  MEMBERSHIP_STATE_TTL_MS,
  MembershipStateService,
  membershipStandingChannel,
} from "../../../common/auth/membership-state.service";
import { scheduleStandingRevocation } from "../../../common/rbac/access-mutation-commit";
import type { CacheService } from "../../../common/cache/cache.service";
import type { Db } from "../../../db/drizzle.module";

const USER = "user-1";
const ORG = "org-1";

interface DurableMembership {
  row: { status: string } | null;
}

function makeDb(durable: DurableMembership) {
  const reads = jest.fn();
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where", "orderBy"]) chain[method] = () => chain;
  chain["limit"] = () => {
    reads();
    if (!durable.row) return Promise.resolve([]);
    return Promise.resolve([
      {
        membershipId: 1,
        status: durable.row.status,
        isOwner: false,
        role: "MEMBER",
        userIsActive: true,
        userDeletedAt: null,
        orgStatus: "ACTIVE",
        orgDeletedAt: null,
      },
    ]);
  };
  const tx = { execute: async () => undefined, select: () => chain };
  const db = {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    execute: async () => undefined,
    select: () => chain,
  };
  return { db: db as unknown as Db, reads };
}

function makeRedisDownCache(): CacheService {
  const redisDown = () => Promise.reject(new Error("redis down"));
  const staleActive = { active: true, isOwner: false, role: "MEMBER", membershipId: 1 };
  return {
    cachedVersioned: jest.fn().mockResolvedValue(staleActive),
    get: jest.fn().mockResolvedValue(staleActive),
    set: jest.fn().mockImplementation(redisDown),
    invalidate: jest.fn().mockImplementation(redisDown),
    invalidateMany: jest.fn().mockImplementation(redisDown),
    invalidateNamespace: jest.fn().mockImplementation(redisDown),
    invalidateNamespaceMany: jest.fn().mockImplementation(redisDown),
  } as unknown as CacheService;
}

function makeOtherInstance(db: Db): MembershipStateService {
  return new MembershipStateService(db);
}

async function revokeWithRedisDown(durable: DurableMembership, next: DurableMembership["row"]) {
  durable.row = next;
  await scheduleStandingRevocation(makeRedisDownCache(), [USER]).catch(() => undefined);
}

function pastLocalWindow(): jest.SpyInstance<number, []> {
  return jest.spyOn(Date, "now").mockReturnValue(Date.now() + MEMBERSHIP_STATE_TTL_MS + 1);
}

describe("membership revocation fails closed on another instance when the shared cache is unreachable", () => {
  afterEach(() => {
    membershipStandingChannel.reset();
    jest.restoreAllMocks();
  });

  it("denies a suspended member on another instance once the local window passes, with Redis down for the bust", async () => {
    const durable: DurableMembership = { row: { status: "ACTIVE" } };
    const reader = makeOtherInstance(makeDb(durable).db);
    await expect(reader.resolve(USER, ORG)).resolves.toMatchObject({ active: true });

    await revokeWithRedisDown(durable, { status: "SUSPENDED" });

    const clock = pastLocalWindow();
    const state = await reader.resolve(USER, ORG);
    clock.mockRestore();
    expect(state.active).toBe(false);
  });

  it("denies a removed member on another instance once the local window passes, with Redis down for the bust", async () => {
    const durable: DurableMembership = { row: { status: "ACTIVE" } };
    const reader = makeOtherInstance(makeDb(durable).db);
    await expect(reader.resolve(USER, ORG)).resolves.toMatchObject({ active: true });

    await revokeWithRedisDown(durable, null);

    const clock = pastLocalWindow();
    const state = await reader.resolve(USER, ORG);
    clock.mockRestore();
    expect(state).toEqual({ active: false, isOwner: false, role: "", membershipId: null });
  });

  it("keeps an unchanged active member allowed past the local window, with Redis down", async () => {
    const durable: DurableMembership = { row: { status: "ACTIVE" } };
    const reader = makeOtherInstance(makeDb(durable).db);
    await expect(reader.resolve(USER, ORG)).resolves.toMatchObject({ active: true });

    const clock = pastLocalWindow();
    const state = await reader.resolve(USER, ORG);
    clock.mockRestore();
    expect(state.active).toBe(true);
  });

  it("issues one database read per organisation and user per instance inside the local window", async () => {
    const durable: DurableMembership = { row: { status: "ACTIVE" } };
    const { db, reads } = makeDb(durable);
    const reader = makeOtherInstance(db);

    await Promise.all([reader.resolve(USER, ORG), reader.resolve(USER, ORG)]);
    await reader.resolve(USER, ORG);
    expect(reads).toHaveBeenCalledTimes(1);

    const clock = pastLocalWindow();
    await reader.resolve(USER, ORG);
    clock.mockRestore();
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("clears the writing instance's own copy at once when the revocation commits, with Redis down", async () => {
    const durable: DurableMembership = { row: { status: "ACTIVE" } };
    const writer = makeOtherInstance(makeDb(durable).db);
    writer.onModuleInit();
    await expect(writer.resolve(USER, ORG)).resolves.toMatchObject({ active: true });

    await revokeWithRedisDown(durable, { status: "SUSPENDED" });

    await expect(writer.resolve(USER, ORG)).resolves.toMatchObject({ active: false });
    writer.onModuleDestroy();
  });

  it("denies a deactivated account on another instance once the local window passes", async () => {
    const durable: DurableMembership = { row: { status: "ACTIVE" } };
    const users = { active: true };
    const { db } = makeDb(durable);
    const accountDb = {
      ...(db as unknown as Record<string, unknown>),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ isActive: users.active, deletedAt: null }],
          }),
        }),
      }),
    } as unknown as Db;
    const reader = makeOtherInstance(accountDb);
    await expect(reader.isAccountActive(USER)).resolves.toBe(true);

    users.active = false;
    await scheduleStandingRevocation(makeRedisDownCache(), [USER]).catch(() => undefined);

    const clock = pastLocalWindow();
    const active = await reader.isAccountActive(USER);
    clock.mockRestore();
    expect(active).toBe(false);
  });
});
