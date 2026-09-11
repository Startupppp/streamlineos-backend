import {
  buildOrgDashboardCacheKey,
  buildScopedDashboardCacheKey,
} from "./dashboard-cache-key";
import type { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ScopedRead } from "../access/scoped-read";
import type { DataScope } from "../access/access.types";

function makeAccess(version = 1): Pick<AccessService, "getPermissionsVersion"> {
  return { getPermissionsVersion: jest.fn().mockResolvedValue(version) };
}

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return { userId: "user-1", orgId: "org-a", ...overrides } as CurrentUserContext;
}

function read(u: CurrentUserContext, scope: DataScope): ScopedRead {
  return ScopedRead.of(u.orgId, u.userId, scope);
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
  it("embeds the userId in the key for a per-actor scope", async () => {
    const u = makeUser({ userId: "user-99" });
    const key = await buildScopedDashboardCacheKey(makeAccess() as AccessService, u, "resource", read(u, "own"));
    expect(key).toContain("user-99");
  });

  it("embeds the discriminator, actor-qualified for own but not for all", async () => {
    const access = makeAccess() as AccessService;
    const u = makeUser();
    const allKey = await buildScopedDashboardCacheKey(access, u, "resource", read(u, "all"));
    const ownKey = await buildScopedDashboardCacheKey(access, u, "resource", read(u, "own"));
    expect(allKey).toContain("all");
    expect(ownKey).toContain(`own:${u.userId}`);
  });

  it("BITE: two callers with different scopes must not receive the same key", async () => {
    const access = makeAccess(1) as AccessService;
    const u = makeUser();
    const allKey = await buildScopedDashboardCacheKey(access, u, "pending-approvals", read(u, "all"));
    const ownKey = await buildScopedDashboardCacheKey(access, u, "pending-approvals", read(u, "own"));
    expect(allKey).not.toBe(ownKey);
  });

  it("BITE: two users with own scope must not share a key", async () => {
    const access = makeAccess(1) as AccessService;
    const u1 = makeUser({ userId: "user-1" });
    const u2 = makeUser({ userId: "user-2" });
    const key1 = await buildScopedDashboardCacheKey(access, u1, "pending-approvals", read(u1, "own"));
    const key2 = await buildScopedDashboardCacheKey(access, u2, "pending-approvals", read(u2, "own"));
    expect(key1).not.toBe(key2);
  });

  it("two users with all scope legitimately share a key — the result does not depend on identity", async () => {
    const access = makeAccess(1) as AccessService;
    const u1 = makeUser({ userId: "user-1" });
    const u2 = makeUser({ userId: "user-2" });
    const key1 = await buildScopedDashboardCacheKey(access, u1, "pending-approvals", read(u1, "all"));
    const key2 = await buildScopedDashboardCacheKey(access, u2, "pending-approvals", read(u2, "all"));
    expect(key1).toBe(key2);
  });
});

describe("key selection contract", () => {
  it("org key returns identical results for two callers — confirms org-uniform payload is cached once for all members", async () => {
    const access = makeAccess(1) as AccessService;
    const keyForAliceOrg = await buildOrgDashboardCacheKey(access, "org-a", "holidays", "2026-08-31");
    const keyForBobSameOrg = await buildOrgDashboardCacheKey(access, "org-a", "holidays", "2026-08-31");
    expect(keyForAliceOrg).toBe(keyForBobSameOrg);
  });

  it("scoped key returns distinct results for two callers with own scope — confirms scope-dependent payload must not be shared across callers", async () => {
    const access = makeAccess(1) as AccessService;
    const alice = makeUser({ userId: "alice", orgId: "org-a" });
    const bob = makeUser({ userId: "bob", orgId: "org-a" });
    const aliceKey = await buildScopedDashboardCacheKey(access, alice, "pending-approvals", read(alice, "own"));
    const bobKey = await buildScopedDashboardCacheKey(access, bob, "pending-approvals", read(bob, "own"));
    expect(aliceKey).not.toBe(bobKey);
  });
});

describe("locale dimension (ITEM D)", () => {
  it("BITE: two callers identical except for locale must not share a cache entry", async () => {
    const access = makeAccess(1) as AccessService;
    const u = makeUser();
    const enKey = await buildScopedDashboardCacheKey(access, u, "upcoming-events", read(u, "all"), undefined, "en-US");
    const hiKey = await buildScopedDashboardCacheKey(access, u, "upcoming-events", read(u, "all"), undefined, "hi-IN");
    expect(enKey).not.toBe(hiKey);
  });

  it("locale value appears verbatim in the key", async () => {
    const access = makeAccess(1) as AccessService;
    const u = makeUser();
    const key = await buildScopedDashboardCacheKey(access, u, "upcoming-events", read(u, "all"), undefined, "en-US");
    expect(key).toContain("en-US");
  });

  it("omitting locale produces the same key as before the locale parameter was added", async () => {
    const access = makeAccess(1) as AccessService;
    const u = makeUser();
    const withoutLocale = await buildScopedDashboardCacheKey(access, u, "upcoming-events", read(u, "all"));
    const withUndefinedLocale = await buildScopedDashboardCacheKey(access, u, "upcoming-events", read(u, "all"), undefined, undefined);
    expect(withoutLocale).toBe(withUndefinedLocale);
    expect(withoutLocale).not.toContain("en-US");
  });

  it("locale is appended after dimension when both are provided", async () => {
    const access = makeAccess(1) as AccessService;
    const u = makeUser();
    const key = await buildScopedDashboardCacheKey(access, u, "attendance", read(u, "all"), "2026-08-31", "en-US");
    expect(key).toContain("2026-08-31");
    expect(key).toContain("en-US");
    const dimIdx = key.indexOf("2026-08-31");
    const locIdx = key.indexOf("en-US");
    expect(locIdx).toBeGreaterThan(dimIdx);
  });
});
