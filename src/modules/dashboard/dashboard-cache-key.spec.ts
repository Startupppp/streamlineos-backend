import {
  buildOrgDashboardCacheKey,
  buildScopedDashboardCacheKey,
} from "./dashboard-cache-key";
import type { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function makeAccess(version = 1): Pick<AccessService, "getPermissionsVersion"> {
  return { getPermissionsVersion: jest.fn().mockResolvedValue(version) };
}

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return { userId: "user-1", orgId: "org-a", ...overrides } as CurrentUserContext;
}

describe("buildOrgDashboardCacheKey", () => {
  it("embeds the resource and version but no userId or scope", async () => {
    const key = await buildOrgDashboardCacheKey(
      makeAccess(5) as AccessService,
      "org-a",
      "stats",
    );
    expect(key).toContain("stats");
    expect(key).toContain("v5");
    expect(key).not.toMatch(/user-/);
    expect(key).not.toMatch(/scope/);
  });

  it("appends dimension when provided", async () => {
    const key = await buildOrgDashboardCacheKey(
      makeAccess() as AccessService,
      "org-a",
      "holidays",
      "2026-08-31",
    );
    expect(key).toContain("holidays");
    expect(key).toContain("2026-08-31");
  });

  it("produces IDENTICAL keys for two callers in the same org — correct for org-uniform data", async () => {
    const access = makeAccess(1) as AccessService;
    const key1 = await buildOrgDashboardCacheKey(access, "org-a", "birthdays", "2026-08-31");
    const key2 = await buildOrgDashboardCacheKey(access, "org-a", "birthdays", "2026-08-31");
    expect(key1).toBe(key2);
  });

  it("changes when the permissions version changes, so a permission bump invalidates the entry", async () => {
    const keyV1 = await buildOrgDashboardCacheKey(makeAccess(1) as AccessService, "org-a", "stats");
    const keyV2 = await buildOrgDashboardCacheKey(makeAccess(2) as AccessService, "org-a", "stats");
    expect(keyV1).not.toBe(keyV2);
  });
});

describe("buildScopedDashboardCacheKey", () => {
  it("embeds the userId in the key", async () => {
    const key = await buildScopedDashboardCacheKey(
      makeAccess() as AccessService,
      makeUser({ userId: "user-99" }),
      "resource",
      "all",
    );
    expect(key).toContain("user-99");
  });

  it("embeds the DataScope in the key", async () => {
    const access = makeAccess() as AccessService;
    const u = makeUser();
    const allKey = await buildScopedDashboardCacheKey(access, u, "resource", "all");
    const ownKey = await buildScopedDashboardCacheKey(access, u, "resource", "own");
    expect(allKey).toContain("all");
    expect(ownKey).toContain("own");
  });

  it("BITE: two callers with different DataScopes must not receive the same key", async () => {
    const access = makeAccess(1) as AccessService;
    const u = makeUser();
    const allKey = await buildScopedDashboardCacheKey(access, u, "pending-approvals", "all");
    const ownKey = await buildScopedDashboardCacheKey(access, u, "pending-approvals", "own");
    expect(allKey).not.toBe(ownKey);
  });

  it("BITE: two users with the same scope must not share a key", async () => {
    const access = makeAccess(1) as AccessService;
    const u1 = makeUser({ userId: "user-1" });
    const u2 = makeUser({ userId: "user-2" });
    const key1 = await buildScopedDashboardCacheKey(access, u1, "pending-approvals", "all");
    const key2 = await buildScopedDashboardCacheKey(access, u2, "pending-approvals", "all");
    expect(key1).not.toBe(key2);
  });
});

describe("key selection contract", () => {
  it("org key returns identical results for two callers — confirms org-uniform payload is cached once for all members", async () => {
    const access = makeAccess(1) as AccessService;
    const keyForAliceOrg = await buildOrgDashboardCacheKey(access, "org-a", "holidays", "2026-08-31");
    const keyForBobSameOrg = await buildOrgDashboardCacheKey(access, "org-a", "holidays", "2026-08-31");
    expect(keyForAliceOrg).toBe(keyForBobSameOrg);
  });

  it("scoped key returns distinct results for two callers — confirms scope-dependent payload must not be shared across callers", async () => {
    const access = makeAccess(1) as AccessService;
    const alice = makeUser({ userId: "alice", orgId: "org-a" });
    const bob = makeUser({ userId: "bob", orgId: "org-a" });
    const aliceKey = await buildScopedDashboardCacheKey(access, alice, "pending-approvals", "own");
    const bobKey = await buildScopedDashboardCacheKey(access, bob, "pending-approvals", "own");
    expect(aliceKey).not.toBe(bobKey);
  });
});
