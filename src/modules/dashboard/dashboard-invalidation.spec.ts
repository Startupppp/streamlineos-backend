import { CACHE_KEYS } from "../../common/cache/cache-keys";
import type { CacheService } from "../../common/cache/cache.service";
import type { AccessService } from "../access/access.service";
import type { Db } from "../../db/drizzle.module";
import { DashboardAnnouncementsService } from "./dashboard-announcements.service";
import {
  buildScopedDashboardCacheKey,
  buildOrgDashboardCacheKey,
} from "./dashboard-cache-key";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const ORG_A = "org-inv-test-a";
const ORG_B = "org-inv-test-b";
const USER_A = "user-inv-test-a";
const USER_B = "user-inv-test-b";

function makeAccess(version = 1): AccessService {
  return {
    getPermissionsVersion: jest.fn().mockResolvedValue(version),
    holds: jest.fn().mockResolvedValue(true),
  } as unknown as AccessService;
}

function makeUser(orgId: string, userId: string): CurrentUserContext {
  return { orgId, userId } as CurrentUserContext;
}

describe("ITEM E — mutation invalidates ONLY the affected section prefix", () => {
  function makeDb(): Db {
    return {
      insert: jest.fn().mockReturnValue({
        values: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }),
      }),
      delete: jest.fn().mockReturnValue({
        where: () => Promise.resolve(),
      }),
    } as unknown as Db;
  }

  function makeSpyCache() {
    const invalidatedKeys: string[] = [];
    const cache = {
      cached: jest.fn().mockImplementation(async (_k: string, f: () => Promise<unknown>) => f()),
      cachedForOrg: jest.fn().mockImplementation(async (_orgId: string, _k: string, f: () => Promise<unknown>) => f()),
      invalidate: jest.fn().mockImplementation((key: string) => {
        invalidatedKeys.push(key);
        return Promise.resolve();
      }),
    } as unknown as CacheService;
    return { cache, invalidatedKeys };
  }

  it("BITE: createAnnouncement invalidates ONLY the announcementsList cache key", async () => {
    const { cache, invalidatedKeys } = makeSpyCache();
    const access = makeAccess();
    const db = makeDb();
    const actor = makeUser(ORG_A, USER_A);
    const svc = new DashboardAnnouncementsService(db, cache, access);

    await svc.createAnnouncement(ORG_A, USER_A, actor, {
      title: "Hello",
      content: "World",
      isPinned: false,
    });

    expect(invalidatedKeys).toHaveLength(1);
    expect(invalidatedKeys[0]).toBe(CACHE_KEYS.announcementsList(ORG_A));
  });

  it("BITE: createAnnouncement does NOT invalidate stats, availability, or leave section keys", async () => {
    const { cache, invalidatedKeys } = makeSpyCache();
    const access = makeAccess();
    const db = makeDb();
    const actor = makeUser(ORG_A, USER_A);
    const svc = new DashboardAnnouncementsService(db, cache, access);

    await svc.createAnnouncement(ORG_A, USER_A, actor, {
      title: "Hi",
      content: "Msg",
      isPinned: false,
    });

    const inadvertent = invalidatedKeys.filter(
      (k) => k.includes("stats") || k.includes("availability") || k.includes("leaves"),
    );
    expect(inadvertent).toHaveLength(0);
  });

  it("BITE: deleteAnnouncement invalidates ONLY the announcementsList cache key", async () => {
    const { cache, invalidatedKeys } = makeSpyCache();
    const access = makeAccess();
    const db = makeDb();
    const actor = makeUser(ORG_A, USER_A);
    const svc = new DashboardAnnouncementsService(db, cache, access);

    await svc.deleteAnnouncement(ORG_A, actor, 42);

    expect(invalidatedKeys).toHaveLength(1);
    expect(invalidatedKeys[0]).toBe(CACHE_KEYS.announcementsList(ORG_A));
  });
});

describe("ITEM E — org switch makes all section cache entries unreachable (different org prefix)", () => {
  /**
   * The local scoped key does NOT embed orgId — the org namespace is added by
   * cachedForOrg(orgId, localKey, …).  When a user switches org, every call to
   * cachedForOrg uses a NEW orgId prefix, so every prior entry is unreachable.
   *
   * Two complementary guarantees:
   *   (1) Different orgIds in cachedForOrg → different full keys (structural).
   *   (2) A permission-version bump (which occurs on membership/role change) also
   *       changes the local scoped key, so a mid-session switch also invalidates.
   */

  it("BITE: the org prefix from cachedForOrg makes ORG_A keys distinct from ORG_B keys for the same local key", async () => {
    const { CacheService } = await import("../../common/cache/cache.service");
    const cache = new CacheService(null);
    const access = makeAccess(1);
    const u = makeUser(ORG_A, USER_A);
    const localKey = await buildScopedDashboardCacheKey(access, u, "pending-approvals", "own");

    const fullKeyA = await cache.orgScopedKey(ORG_A, localKey);
    const fullKeyB = await cache.orgScopedKey(ORG_B, localKey);

    expect(fullKeyA).not.toBe(fullKeyB);
    expect(fullKeyA).toContain(ORG_A);
    expect(fullKeyB).toContain(ORG_B);
  });

  it("BITE: permission-version bump changes the local scoped key (covers mid-session org switch)", async () => {
    const u = makeUser(ORG_A, USER_A);
    const [k1, k2] = await Promise.all([
      buildScopedDashboardCacheKey(makeAccess(1), u, "attendance", "all"),
      buildScopedDashboardCacheKey(makeAccess(2), u, "attendance", "all"),
    ]);
    expect(k1).not.toBe(k2);
  });

  it("BITE: permission-version bump changes org-level keys (covers mid-session org switch for org-uniform sections)", async () => {
    const [k1, k2] = await Promise.all([
      buildOrgDashboardCacheKey(makeAccess(1), ORG_A, "stats-employees"),
      buildOrgDashboardCacheKey(makeAccess(2), ORG_A, "stats-employees"),
    ]);
    expect(k1).not.toBe(k2);
  });

  it("BITE: different users in different orgs with different versions — no shared scoped key", async () => {
    const u1 = makeUser(ORG_A, USER_A);
    const u2 = makeUser(ORG_B, USER_B);
    const [k1, k2] = await Promise.all([
      buildScopedDashboardCacheKey(makeAccess(3), u1, "attendance", "all"),
      buildScopedDashboardCacheKey(makeAccess(7), u2, "attendance", "all"),
    ]);
    expect(k1).not.toBe(k2);
  });
});
