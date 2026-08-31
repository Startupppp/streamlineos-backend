/**
 * Cache key correctness — collision and isolation proofs.
 *
 * Each test exercises a cache-key dimension required by backend/CLAUDE.md §6:
 * "The cache key must include every filter that changes the result."
 *
 * Structure per test
 * ──────────────────
 * 1. Positive control – correct key includes the dimension, values stay isolated.
 * 2. Negative control – a stripped key (dimension removed inside the test fixture,
 *    NOT in source) causes the collision.  If the negative control does NOT fail
 *    the assertion the test itself is vacuously true.
 *
 * Dimensions covered
 * ──────────────────
 * D1 – tenant (orgId)
 * D2 – permission version (version counter bump between reads)
 * D3 – request filter (filtered vs unfiltered under the same resource namespace)
 * D4 – locale / timezone
 * D5 – org switch (session cache invalidated on switch, cross-node via Redis)
 * D6 – cross-process propagation: mutation/role/membership/entitlement bump via Redis
 *
 * The negative controls for D1–D4 use a local key-builder that drops the
 * relevant dimension; D5–D6 use the InMemoryRedis `deafToInvalidation` flag
 * to simulate broken invalidation.
 *
 * None of these tests mutate source files.
 */

import type { Redis } from "@upstash/redis";
import { CacheService } from "./cache.service";
import { InMemoryRedis } from "./in-memory-redis.test-double";

// ─── helpers ────────────────────────────────────────────────────────────────

function freshCache(deafToInvalidation = false): CacheService {
  return new CacheService(new InMemoryRedis(deafToInvalidation) as unknown as Redis);
}

/** Shared Redis so two CacheService instances can communicate. */
function sharedCache(): { a: CacheService; b: CacheService; redis: InMemoryRedis } {
  const redis = new InMemoryRedis();
  const a = new CacheService(redis as unknown as Redis);
  const b = new CacheService(redis as unknown as Redis);
  return { a, b, redis };
}

// ─── D1: tenant (orgId) isolation ───────────────────────────────────────────

describe("D1 — tenant isolation: orgId must be in the key", () => {
  it("positive control: cachedForOrg keeps org-A and org-B values separate", async () => {
    const cache = freshCache();

    const a = await cache.cachedForOrg("org-a", "reports:summary", async () => "data-a");
    const b = await cache.cachedForOrg("org-b", "reports:summary", async () => "data-b");

    expect(a).toBe("data-a");
    expect(b).toBe("data-b");
  });

  it("negative control: bare cached() key without orgId makes org-B read org-A data", async () => {
    const cache = freshCache();

    // Stripped key: omits the orgId prefix — both callers share the same key.
    const localKey = "reports:summary";
    const a = await cache.cached(localKey, async () => "data-a");
    const b = await cache.cached(localKey, async () => "data-b");

    // The second read is a cache HIT returning org-A's value — the wrong org's data.
    expect(a).toBe("data-a");
    expect(b).toBe("data-a"); // collision: data-b was never fetched
  });
});

// ─── D2: permission version bump ────────────────────────────────────────────

describe("D2 — permission version: a namespace bump must retire the pre-bump entry", () => {
  const PERM_NS = "access:perms:org-x:user-1";

  it("positive control: invalidateNamespace bumps the version so the next read fetches fresh", async () => {
    const cache = freshCache();
    let calls = 0;

    await cache.cachedVersioned(PERM_NS, "resolved", async () => {
      calls++;
      return { perms: ["hr:view"] };
    });
    expect(calls).toBe(1);

    // Simulate role change → bump the namespace (same as bumpPermissionsVersion does via
    // the shared access version channel hitting invalidateNamespace).
    await cache.invalidateNamespace(PERM_NS);

    await cache.cachedVersioned(PERM_NS, "resolved", async () => {
      calls++;
      return { perms: ["hr:view", "hr:create"] };
    });
    expect(calls).toBe(2); // fetcher ran again — stale v1 entry not served
  });

  it("negative control: when incr is deaf the namespace version never advances — stale perms persist", async () => {
    // deafToInvalidation=true means incr() does not write, so the version stays at 0.
    const cache = freshCache(true);
    let calls = 0;

    await cache.cachedVersioned(PERM_NS, "resolved", async () => {
      calls++;
      return { perms: ["hr:view"] };
    });

    await cache.invalidateNamespace(PERM_NS);

    const result = await cache.cachedVersioned(PERM_NS, "resolved", async () => {
      calls++;
      return { perms: ["hr:view", "hr:create"] };
    });

    // Cache is still warm at v0 — the version counter could not be bumped,
    // so the fetcher was never called a second time and stale data is returned.
    expect(calls).toBe(1);
    expect((result as { perms: string[] }).perms).toEqual(["hr:view"]);
  });
});

// ─── D3: filter dimension ────────────────────────────────────────────────────

describe("D3 — filter dimension: filtered and unfiltered queries must use distinct keys", () => {
  const NAMESPACE = "tickets:org-2:project-5";

  it("positive control: status filter included in key — callers stay isolated", async () => {
    const cache = freshCache();
    let openCalls = 0;
    let allCalls = 0;

    // Filtered: status=OPEN
    const openResult = await cache.cachedVersioned(
      NAMESPACE,
      "page-1:status=OPEN",
      async () => {
        openCalls++;
        return ["ticket-1", "ticket-3"];
      },
    );

    // Unfiltered
    const allResult = await cache.cachedVersioned(
      NAMESPACE,
      "page-1",
      async () => {
        allCalls++;
        return ["ticket-1", "ticket-2", "ticket-3"];
      },
    );

    expect(openResult).toEqual(["ticket-1", "ticket-3"]);
    expect(allResult).toEqual(["ticket-1", "ticket-2", "ticket-3"]);
    expect(openCalls).toBe(1);
    expect(allCalls).toBe(1); // both fetchers ran — no sharing
  });

  it("negative control: filter omitted from key — unfiltered caller receives filtered data", async () => {
    const cache = freshCache();
    let fetchCount = 0;

    // Filtered write lands at a key that has no filter segment.
    const strippedKey = "page-1";

    await cache.cachedVersioned(NAMESPACE, strippedKey, async () => {
      fetchCount++;
      return ["ticket-1", "ticket-3"]; // filtered (OPEN only)
    });

    // Unfiltered read also uses the stripped key → hits the filtered entry.
    const collided = await cache.cachedVersioned(NAMESPACE, strippedKey, async () => {
      fetchCount++;
      return ["ticket-1", "ticket-2", "ticket-3"]; // unfiltered
    });

    expect(fetchCount).toBe(1); // second fetcher never ran
    expect(collided).toEqual(["ticket-1", "ticket-3"]); // unfiltered caller got filtered data
  });
});

// ─── D4: locale / timezone ───────────────────────────────────────────────────

describe("D4 — locale/timezone: rendered data that differs by TZ must use a TZ-scoped key", () => {
  const NAMESPACE = "calendar:org-3:events";

  it("positive control: different timezone keys produce different cached values", async () => {
    const cache = freshCache();

    const utcResult = await cache.cachedVersioned(
      NAMESPACE,
      "week=2024-W02:tz=UTC",
      async () => "Mon 2024-01-08 00:00 UTC",
    );

    const istResult = await cache.cachedVersioned(
      NAMESPACE,
      "week=2024-W02:tz=Asia/Kolkata",
      async () => "Mon 2024-01-08 05:30 IST",
    );

    expect(utcResult).toBe("Mon 2024-01-08 00:00 UTC");
    expect(istResult).toBe("Mon 2024-01-08 05:30 IST");
  });

  it("negative control: TZ omitted from key — IST caller receives UTC-rendered data", async () => {
    const cache = freshCache();
    let fetchCount = 0;

    // UTC fills the key without TZ segment.
    const strippedKey = "week=2024-W02";

    await cache.cachedVersioned(NAMESPACE, strippedKey, async () => {
      fetchCount++;
      return "Mon 2024-01-08 00:00 UTC";
    });

    // IST request hits the same stripped key.
    const collided = await cache.cachedVersioned(NAMESPACE, strippedKey, async () => {
      fetchCount++;
      return "Mon 2024-01-08 05:30 IST";
    });

    expect(fetchCount).toBe(1); // IST fetcher never ran
    expect(collided).toBe("Mon 2024-01-08 00:00 UTC"); // IST caller got UTC data
  });
});

// ─── D5: org switch — session cache invalidated ──────────────────────────────

describe("D5 — org switch: session cache must be invalidated on switch", () => {
  const SESSION_KEY = "user:session:user-42";

  it("positive control: invalidate after switch causes next read to fetch fresh", async () => {
    const cache = freshCache();
    let calls = 0;

    // Prime the session cache (simulates the pre-switch session).
    await cache.cached(SESSION_KEY, async () => {
      calls++;
      return { orgId: "org-old", role: "MEMBER" };
    });
    expect(calls).toBe(1);

    // Switch org → invalidate the session key (mirrors OrgProfileService.switchOrg).
    await cache.invalidate(SESSION_KEY);

    // Next session read must miss and re-fetch the new org context.
    const fresh = await cache.cached(SESSION_KEY, async () => {
      calls++;
      return { orgId: "org-new", role: "OWNER" };
    });

    expect(calls).toBe(2);
    expect((fresh as { orgId: string }).orgId).toBe("org-new");
  });

  it("negative control: without invalidation the stale session persists after switch", async () => {
    const cache = freshCache();
    let calls = 0;

    await cache.cached(SESSION_KEY, async () => {
      calls++;
      return { orgId: "org-old", role: "MEMBER" };
    });

    // No invalidate — simulates a broken switch handler.

    const stale = await cache.cached(SESSION_KEY, async () => {
      calls++;
      return { orgId: "org-new", role: "OWNER" };
    });

    expect(calls).toBe(1); // fetcher did not run again
    expect((stale as { orgId: string }).orgId).toBe("org-old"); // stale data served
  });
});

// ─── D6: cross-process propagation ──────────────────────────────────────────

describe("D6 — cross-process propagation: invalidation must reach a second app instance", () => {
  const NAMESPACE = "crm:contacts:list:org-5";

  it("positive control: instance A bumps namespace via shared Redis, instance B fetches fresh", async () => {
    const { a, b } = sharedCache();
    let bCalls = 0;

    // Instance A primes the namespace in shared Redis.
    await a.cachedVersioned(NAMESPACE, "page-1", async () => "contacts-v1");

    // Instance B reads the same namespace — Redis hit, fetcher NOT called.
    const cached = await b.cachedVersioned(NAMESPACE, "page-1", async () => {
      bCalls++;
      return "contacts-v2-from-b";
    });
    expect(cached).toBe("contacts-v1");
    expect(bCalls).toBe(0);

    // Mutation: instance A invalidates (e.g., a CRM contact was created).
    await a.invalidateNamespace(NAMESPACE);

    // Instance B must now see a bumped version key and fetch fresh.
    const fresh = await b.cachedVersioned(NAMESPACE, "page-1", async () => {
      bCalls++;
      return "contacts-v2-from-b";
    });
    expect(fresh).toBe("contacts-v2-from-b");
    expect(bCalls).toBe(1);
  });

  it("negative control: a process-local-only invalidation does not reach instance B", async () => {
    // deafToInvalidation=true on the shared Redis means the incr call is a no-op,
    // simulating what happens when invalidation only clears the process-local inFlight
    // map without bumping the distributed version counter.
    const redis = new InMemoryRedis(true);
    const a = new CacheService(redis as unknown as Redis);
    const b = new CacheService(redis as unknown as Redis);
    let bCalls = 0;

    await a.cachedVersioned(NAMESPACE, "page-1", async () => "contacts-v1");

    await a.invalidateNamespace(NAMESPACE); // incr silently fails to advance

    const stale = await b.cachedVersioned(NAMESPACE, "page-1", async () => {
      bCalls++;
      return "contacts-v2-from-b";
    });

    expect(bCalls).toBe(0); // instance B never re-fetched
    expect(stale).toBe("contacts-v1"); // stale data still served cross-process
  });

  it("role change: bumpPermissionsVersion (invalidateNamespace) reaches another instance", async () => {
    // Mirrors the RBAC pattern: AccessService.onModuleInit wires
    // subscribeVersionBump → cache.invalidateForOrg / deleteOrgEntries.
    // The distributed half is cache.invalidateNamespace on the shared store.
    const { a, b } = sharedCache();
    const PERMS_NS = "access:perms:org-6:user-9";
    let bCalls = 0;

    await a.cachedVersioned(PERMS_NS, "resolved", async () => ({ keys: ["hr:view"] }));

    // Role changed — instance A bumps the permissions namespace.
    await a.invalidateNamespace(PERMS_NS);

    const fresh = await b.cachedVersioned(PERMS_NS, "resolved", async () => {
      bCalls++;
      return { keys: ["hr:view", "hr:manage"] };
    });

    expect(bCalls).toBe(1);
    expect((fresh as { keys: string[] }).keys).toContain("hr:manage");
  });

  it("membership change: invalidating the org members namespace reaches another instance", async () => {
    const { a, b } = sharedCache();
    const ORG_MEMBERS_NS = "org:members:list:org-7";
    let bCalls = 0;

    await a.cachedVersioned(ORG_MEMBERS_NS, "page-1", async () => ["alice"]);

    // New member joined — instance A invalidates the members list namespace.
    await a.invalidateNamespace(ORG_MEMBERS_NS);

    const fresh = await b.cachedVersioned(ORG_MEMBERS_NS, "page-1", async () => {
      bCalls++;
      return ["alice", "bob"];
    });

    expect(bCalls).toBe(1);
    expect(fresh).toContain("bob");
  });

  it("entitlement change: invalidating the entitlements namespace reaches another instance", async () => {
    const { a, b } = sharedCache();
    const ENT_NS = "billing:entitlements:org-8";
    let bCalls = 0;

    await a.cachedVersioned(ENT_NS, "summary", async () => ({
      plan: "FREE",
      modules: ["build"],
    }));

    // Plan upgraded — instance A invalidates entitlements.
    await a.invalidateNamespace(ENT_NS);

    const fresh = await b.cachedVersioned(ENT_NS, "summary", async () => {
      bCalls++;
      return { plan: "PAID", modules: ["build", "hr", "payroll"] };
    });

    expect(bCalls).toBe(1);
    expect((fresh as { plan: string }).plan).toBe("PAID");
  });
});
